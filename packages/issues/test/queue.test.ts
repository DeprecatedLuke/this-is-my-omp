/**
 * Turn-end queue loop bounds: the stall guard stops reminding an agent that
 * ignores an unchanged queue, and the queue signature tells real progress
 * (an `updated` bump, an issue joining or leaving) from a stall.
 */
import { describe, expect, it } from "bun:test";
import { QueueStallGuard, queueSignature } from "../src/queue";
import type { IssueRecord } from "../src/store";

function queued(id: number, updated: string | undefined): IssueRecord {
	return {
		id,
		category: "infra",
		slug: `issue-${id}`,
		filename: `${id}-issue-${id}.md`,
		filePath: `/issues/infra/${id}-issue-${id}.md`,
		relativePath: `infra/${id}-issue-${id}.md`,
		archived: false,
		frontmatter: { title: `Issue ${id}`, updated },
		body: "",
	};
}

/** Reminders handed out for one signature before the guard gives up (capped so a broken guard can't loop forever). */
function remindersUntilStop(guard: QueueStallGuard, signature: string, max: number): number {
	let reminders = 0;
	while (reminders <= max + 5 && guard.take(signature, max)) reminders += 1;
	return reminders;
}

describe("queue stall guard", () => {
	for (const max of [0, 1, 3]) {
		it(`an unchanged queue gets exactly ${max} reminder(s), then stays stopped`, () => {
			const guard = new QueueStallGuard();
			expect(remindersUntilStop(guard, "4:t1", max)).toBe(max);
			expect(guard.take("4:t1", max)).toBe(false);
		});
	}

	it("a changed signature restores the full allowance", () => {
		const guard = new QueueStallGuard();
		expect(remindersUntilStop(guard, "4:t1", 2)).toBe(2);
		expect(remindersUntilStop(guard, "4:t2", 2)).toBe(2);
		// Going back to an earlier queue is a change too, not a stall.
		expect(remindersUntilStop(guard, "4:t1", 2)).toBe(2);
	});

	it("reset clears the stall count for the same signature", () => {
		const guard = new QueueStallGuard();
		expect(remindersUntilStop(guard, "4:t1", 2)).toBe(2);
		guard.reset();
		expect(remindersUntilStop(guard, "4:t1", 2)).toBe(2);
	});
});

describe("queue signature", () => {
	const a = queued(4, "2026-01-01T00:00:00.000Z");
	const b = queued(7, "2026-01-02T00:00:00.000Z");

	it("ignores queue order", () => {
		expect(queueSignature([a, b])).toBe(queueSignature([b, a]));
	});

	it("changes when one issue's updated changes, or when an issue joins or leaves", () => {
		const base = queueSignature([a, b]);
		const touched = queued(7, "2026-01-03T00:00:00.000Z");
		expect(queueSignature([a, touched])).not.toBe(base);
		expect(queueSignature([a])).not.toBe(base);
		expect(queueSignature([a, b, queued(9, undefined)])).not.toBe(base);
		// Same timestamps on different ids are different queues.
		expect(queueSignature([queued(5, a.frontmatter.updated), b])).not.toBe(base);
	});
});
