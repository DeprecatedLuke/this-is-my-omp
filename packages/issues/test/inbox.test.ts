/**
 * User-local inbox: the locks and hand-offs parallel sessions race on. A claim
 * and a reply take must each have exactly one winner, a session going away
 * frees only its own claims, a claim outlives a live holder but not a stale
 * one, and the seen watermark is fixed at first use.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addReply,
	claim,
	claimIsStale,
	claimOwner,
	listReplies,
	loadSeen,
	markSeen,
	PRESENCE_STALE_MS,
	releaseSessionClaims,
	takeReply,
	touchPresence,
} from "../src/inbox";
import { useTempAgentDir } from "./agent-dir";

useTempAgentDir();

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-inbox-"));
});

afterEach(async () => {
	setSystemTime();
	await fs.rm(tempDir, { recursive: true, force: true });
});

const ROUNDS = 25;
const SESSIONS = ["session-a", "session-b", "session-c", "session-d"];

/**
 * Move the clock past the presence window, then refresh the given sessions'
 * heartbeats on the new clock: they stay live, every other session (and every
 * hold written before the jump) reads as stale.
 */
async function outliveWindow(...stillLive: string[]): Promise<void> {
	setSystemTime(new Date(Date.now() + PRESENCE_STALE_MS + 1_000));
	for (const session of stillLive) await touchPresence(tempDir, session);
}

describe("inbox: claims", () => {
	it("parallel claims on one issue have exactly one winner, and the owner is that winner", async () => {
		for (let id = 1; id <= ROUNDS; id++) {
			const results = await Promise.all(SESSIONS.map(session => claim(tempDir, id, session)));
			const winners = SESSIONS.filter((_, i) => results[i]);
			expect({ id, winners: winners.length }).toEqual({ id, winners: 1 });
			expect(await claimOwner(tempDir, id)).toBe(winners[0]);
			// Re-claiming is idempotent for the owner and still refused to everyone else.
			for (const session of SESSIONS) {
				expect(await claim(tempDir, id, session)).toBe(session === winners[0]);
			}
		}
	});

	it("releaseSessionClaims frees only that session's claims", async () => {
		expect(await claim(tempDir, 1, "session-a")).toBe(true);
		expect(await claim(tempDir, 2, "session-a")).toBe(true);
		expect(await claim(tempDir, 3, "session-b")).toBe(true);
		// A session id that is a prefix of another must not match it.
		expect(await claim(tempDir, 4, "session-ab")).toBe(true);

		expect(await releaseSessionClaims(tempDir, "session-a")).toBe(2);

		expect(await claimOwner(tempDir, 1)).toBeUndefined();
		expect(await claimOwner(tempDir, 2)).toBeUndefined();
		expect(await claimOwner(tempDir, 3)).toBe("session-b");
		expect(await claimOwner(tempDir, 4)).toBe("session-ab");
		// The freed issues are claimable again; the others still are not.
		expect(await claim(tempDir, 1, "session-c")).toBe(true);
		expect(await claim(tempDir, 3, "session-c")).toBe(false);
		expect(await releaseSessionClaims(tempDir, "session-a")).toBe(0);
	});

	it("a claim whose holder's heartbeat went stale is taken over; a live holder's is not", async () => {
		for (const session of ["session-a", "session-b", "session-c"]) await touchPresence(tempDir, session);
		expect(await claim(tempDir, 1, "session-a")).toBe(true);
		expect(await claim(tempDir, 2, "session-b")).toBe(true);
		expect(await claim(tempDir, 1, "session-c")).toBe(false);

		await outliveWindow("session-b", "session-c");

		expect(await claimIsStale(tempDir, 1)).toBe(true);
		expect(await claim(tempDir, 1, "session-c")).toBe(true);
		expect(await claimOwner(tempDir, 1)).toBe("session-c");
		expect(await claimIsStale(tempDir, 2)).toBe(false);
		expect(await claim(tempDir, 2, "session-c")).toBe(false);
		expect(await claimOwner(tempDir, 2)).toBe("session-b");
	});

	it("a claim by a session with no heartbeat holds for the stale window, then is taken over", async () => {
		// A session writes its presence after its first claim; the claim must not be lost meanwhile.
		expect(await claim(tempDir, 1, "unregistered")).toBe(true);
		await touchPresence(tempDir, "session-c");
		expect(await claim(tempDir, 1, "session-c")).toBe(false);

		await outliveWindow("session-c");

		expect(await claim(tempDir, 1, "session-c")).toBe(true);
		expect(await claimOwner(tempDir, 1)).toBe("session-c");
	});
});

describe("inbox: replies", () => {
	it("parallel takes of one reply hand its text to exactly one session", async () => {
		for (let round = 0; round < ROUNDS; round++) {
			const reply = await addReply(tempDir, 7, `Reply ${round}`);
			const taken = await Promise.all(SESSIONS.map(session => takeReply(tempDir, reply, session)));
			expect(taken.filter(text => text !== undefined)).toEqual([`Reply ${round}`]);
			expect(await listReplies(tempDir)).toEqual([]);
		}
	});

	it("lists pending replies oldest first across issues, with the queue time from the file", async () => {
		setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
		await addReply(tempDir, 1, "Second.");
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		await addReply(tempDir, 9, "  First.  \n");
		setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
		await addReply(tempDir, 9, "Third.");
		await expect(addReply(tempDir, 9, " \n\t ")).rejects.toThrow("Reply is empty.");

		const pending = await listReplies(tempDir);
		expect(pending.map(reply => [reply.id, reply.text, reply.at])).toEqual([
			[9, "First.", "2026-01-01T00:00:00.000Z"],
			[1, "Second.", "2026-01-02T00:00:00.000Z"],
			[9, "Third.", "2026-01-03T00:00:00.000Z"],
		]);
	});
});

describe("inbox: seen state", () => {
	it("loadSeen writes the watermark on first use and never moves it afterwards", async () => {
		const first = new Date("2026-01-01T00:00:00.000Z");
		setSystemTime(first);
		expect((await loadSeen(tempDir)).watermark).toBe(first.toISOString());

		setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
		const later = await loadSeen(tempDir);
		expect(later.watermark).toBe(first.toISOString());
		expect(later.seen.size).toBe(0);
	});

	it("markSeen round-trips through loadSeen, last stamp per issue wins", async () => {
		await markSeen(tempDir, 3, "2026-01-01T00:00:00.000Z");
		await markSeen(tempDir, 3, "2026-02-01T00:00:00.000Z");
		await markSeen(tempDir, 12, "2026-03-01T00:00:00.000Z");

		const { seen } = await loadSeen(tempDir);
		expect([...seen].sort(([a], [b]) => a - b)).toEqual([
			[3, "2026-02-01T00:00:00.000Z"],
			[12, "2026-03-01T00:00:00.000Z"],
		]);
	});
});
