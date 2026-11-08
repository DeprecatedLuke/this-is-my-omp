/**
 * Turn-end queue loop bounds: the stall guard stops reminding an agent that
 * ignores an unchanged queue, and the queue signature tells real progress (a
 * stage or status change, an issue joining or leaving, a new board reply) from a
 * stall — including an agent that only rewrites its issue body every turn.
 */
import { describe, expect, it } from "bun:test";
import type { PendingReply } from "../src/inbox";
import { QueueStallGuard, queueSignature } from "../src/queue";
import type { IssueFrontmatter, IssueRecord } from "../src/store";

function queued(id: number, frontmatter: Partial<IssueFrontmatter> = {}, body = ""): IssueRecord {
	return {
		id,
		category: "infra",
		slug: `issue-${id}`,
		filename: `${id}-issue-${id}.md`,
		filePath: `/issues/infra/${id}-issue-${id}.md`,
		relativePath: `infra/${id}-issue-${id}.md`,
		archived: false,
		frontmatter: {
			title: `Issue ${id}`,
			status: "open",
			stage: "running",
			updated: "2026-01-01T00:00:00.000Z",
			...frontmatter,
		},
		body,
	};
}

function reply(id: number, n: number): PendingReply {
	return { id, file: `/inbox/${id}-${n}.md`, text: `Reply ${n}.`, at: `2026-01-0${n}T00:00:00.000Z` };
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
	const a = queued(4);
	const b = queued(7, { stage: "up-next" });
	const base = queueSignature([a, b], []);

	it("ignores queue and reply order", () => {
		expect(queueSignature([b, a], [])).toBe(base);
		expect(queueSignature([a, b], [reply(4, 1), reply(7, 2)])).toBe(
			queueSignature([b, a], [reply(7, 2), reply(4, 1)]),
		);
	});

	const stalls: Array<{ name: string; queue: IssueRecord[]; pending: PendingReply[] }> = [
		{
			name: "the agent rewrote the body and bumped updated",
			queue: [a, queued(7, { stage: "up-next", updated: "2026-01-05T00:00:00.000Z" }, "Rewritten body.")],
			pending: [],
		},
		{ name: "a reply is pending for an issue that is not queued", queue: [a, b], pending: [reply(9, 1)] },
	];
	for (const row of stalls) {
		it(`stays the same when ${row.name}`, () => {
			expect(queueSignature(row.queue, row.pending)).toBe(base);
		});
	}

	const progress: Array<{ name: string; queue: IssueRecord[]; pending: PendingReply[] }> = [
		{ name: "one issue's stage changed", queue: [a, queued(7, { stage: "running" })], pending: [] },
		{ name: "one issue's stage was cleared", queue: [a, queued(7, { stage: undefined })], pending: [] },
		{
			name: "one issue's status changed",
			queue: [a, queued(7, { stage: "up-next", status: "in-progress" })],
			pending: [],
		},
		{ name: "an issue left", queue: [a], pending: [] },
		{ name: "an issue joined", queue: [a, b, queued(9)], pending: [] },
		{ name: "a reply is pending for a queued issue", queue: [a, b], pending: [reply(7, 1)] },
	];
	for (const row of progress) {
		it(`changes when ${row.name}`, () => {
			expect(queueSignature(row.queue, row.pending)).not.toBe(base);
		});
	}

	it("a second reply for the same queued issue changes it again", () => {
		const one = queueSignature([a, b], [reply(7, 1)]);
		expect(queueSignature([a, b], [reply(7, 1), reply(7, 2)])).not.toBe(one);
	});

	it("identical stage and status on different ids are different queues", () => {
		expect(queueSignature([queued(5)], [])).not.toBe(queueSignature([queued(6)], []));
	});
});
