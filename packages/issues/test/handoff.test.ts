/**
 * Plugin hand-off: which main session is handed board work, and what a hand-off
 * does to the issue. Nothing is handed out on its own — an issue becomes a
 * session's work when that session sets it `running` through the tool — so every
 * scenario runs two live sessions and checks the other one never gets the work.
 * Driven through the real plugin with a minimal host per session: it runs the
 * plugin's event handlers in registration order, holds its tool, and carries the
 * session context the handlers read.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { claimOwner, listQueued, listReplies, PRESENCE_STALE_MS, setQueued } from "../src/inbox";
import issuesPlugin from "../src/index";
import { addIssue, findIssueById, moveIssue, replyToIssue, saveIssueContent } from "../src/store";
import type { IssuesToolDetails, IssuesToolParams, issuesTool } from "../src/tool";
import { useTempAgentDir } from "./agent-dir";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** One main session: the real plugin loaded into a host that only routes its events and its tool. */
interface Session {
	/** Run every handler the plugin registered for `event`, in order; the last result wins. */
	fire(event: string, payload?: unknown): Promise<unknown>;
	/** A user prompt: the reply reminder the plugin attached to it, if any. */
	prompt(): Promise<string | undefined>;
	/** A turn end: the reminder that keeps the session going, if any. */
	turnEnd(): Promise<string | undefined>;
	/** Call the `issues` tool from this session. */
	tool(params: IssuesToolParams): Promise<AgentToolResult<IssuesToolDetails>>;
	/** The host moved this session to a new id (`/new`, a switch, a branch). */
	switchTo(sessionId: string): void;
}

let tempDir: string;
const opened: Session[] = [];

// Registered before the agent-dir isolation, so it runs first: shutting every
// session down stops its heartbeat timer while the inbox still resolves to the
// temp agent dir.
afterEach(async () => {
	for (const session of opened.splice(0)) await session.fire("session_shutdown");
});

useTempAgentDir();

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-handoff-"));
});

afterEach(async () => {
	setSystemTime();
	await fs.rm(tempDir, { recursive: true, force: true });
});

/** Load the plugin as main session `sessionId` in the temp checkout. */
function openSession(sessionId: string): Session {
	let id = sessionId;
	const handlers = new Map<string, Handler[]>();
	let tool: typeof issuesTool | undefined;
	const pi = {
		logger: { warn() {}, debug() {} },
		registerTool(definition: typeof issuesTool) {
			tool = definition;
		},
		registerMessageRenderer() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getActiveTools: () => [],
	};
	issuesPlugin(pi as unknown as ExtensionAPI);
	const ctx = {
		cwd: tempDir,
		agent: { kind: "main" },
		sessionManager: { getSessionId: () => id },
		getAsyncJobSnapshot: () => null,
	} as unknown as ExtensionContext;
	const fire = async (event: string, payload: unknown = {}): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const value = await handler(payload, ctx);
			if (value !== undefined) result = value;
		}
		return result;
	};
	const session: Session = {
		fire,
		async prompt() {
			const result = await fire("before_agent_start", { systemPrompt: [], reason: "prompt" });
			return (result as { message?: { content: string } } | undefined)?.message?.content;
		},
		async turnEnd() {
			const result = await fire("session_stop");
			return (result as { additionalContext?: string } | undefined)?.additionalContext;
		},
		tool: params => tool!.execute("call", params, undefined, undefined, ctx),
		switchTo(next) {
			id = next;
		},
	};
	opened.push(session);
	return session;
}

function at(day: number): Date {
	return new Date(Date.UTC(2026, 0, day));
}

/** Two live main sessions in one checkout, each registered the way the host starts it. */
async function twoSessions(): Promise<{ a: Session; b: Session }> {
	const a = openSession("session-a");
	const b = openSession("session-b");
	await a.fire("session_start");
	await b.fire("session_start");
	return { a, b };
}

async function plainIssue(title: string, status: "open" | "in-progress" = "open"): Promise<number> {
	return (await addIssue(tempDir, { category: "infra", title, body: "B.", status })).record.id;
}

/** An active `up-next` issue the user queued on this machine. */
async function queuedIssue(title: string): Promise<number> {
	const { record } = await addIssue(tempDir, { category: "infra", title, body: "B.", extra: { stage: "up-next" } });
	await setQueued(tempDir, record.id, true);
	return record.id;
}

/** `session` takes issue `id` the only way there is: the agent sets it `running` through the tool. */
async function start(session: Session, id: number, sessionId: string): Promise<void> {
	const result = await session.tool({ op: "stage", id, stage: "running" });
	expect(result.isError).toBeUndefined();
	expect(await claimOwner(tempDir, id)).toBe(sessionId);
}

/** The board's "Up next" move: what a user requeue writes. */
async function requeue(id: number): Promise<void> {
	await moveIssue(tempDir, id, { stage: "up-next" });
	await setQueued(tempDir, id, true);
}

async function pendingTexts(): Promise<string[]> {
	return (await listReplies(tempDir)).map(reply => reply.text);
}

describe("issues plugin: hand-off marks the issue running", () => {
	it("a reply delivered at prompt time moves its held issue back to running", async () => {
		const { a } = await twoSessions();
		const id = await plainIssue("Flaky deploy");
		await start(a, id, "session-a");
		await a.tool({ op: "stage", id, stage: "needs-you" });
		await replyToIssue(tempDir, id, "Please retry on arm.");
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("up-next");

		expect(await a.prompt()).toContain("Please retry on arm.");
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("running");
	});

	it("turn-end hand-off writes running once, so later turns leave the file alone and the stall guard ends the loop", async () => {
		const { a } = await twoSessions();
		const id = await plainIssue("Flaky deploy");
		await start(a, id, "session-a");
		await a.tool({ op: "stage", id, stage: "needs-you" });
		await requeue(id);
		const filePath = (await findIssueById(tempDir, id))!.filePath;

		setSystemTime(at(1));
		expect(await a.turnEnd()).toContain("Flaky deploy");
		const handedOff = await findIssueById(tempDir, id);
		expect(handedOff?.frontmatter.stage).toBe("running");
		expect(handedOff?.frontmatter.updated).toBe(at(1).toISOString());
		const fileAfterHandOff = await Bun.file(filePath).text();

		// The agent ignores the queue. Each turn runs on a later clock, so any
		// rewrite would bump `updated`; the file must stay byte-identical and
		// the reminders must stop instead of looping forever.
		const turns = 10;
		let reminders = 0;
		for (let turn = 2; turn <= turns; turn++) {
			setSystemTime(at(turn));
			const result = await a.turnEnd();
			expect(await Bun.file(filePath).text()).toBe(fileAfterHandOff);
			if (result === undefined) break;
			reminders += 1;
		}
		expect(reminders).toBeLessThan(turns - 1);
		// Still in flight: the issue keeps its queue mark.
		expect([...(await listQueued(tempDir))]).toEqual([id]);
	});

	it("an agent that rewrites its running issue's body every turn still gets a bounded number of reminders", async () => {
		const { a } = await twoSessions();
		const id = await queuedIssue("Flaky deploy");
		await start(a, id, "session-a");
		const filePath = (await findIssueById(tempDir, id))!.filePath;

		// Before each turn end the agent appends a note through the issue file
		// write path, on a later clock, so the body and `updated` change every
		// turn while stage and status stay put.
		const turns = 12;
		let reminders = 0;
		let stopped = false;
		for (let turn = 1; turn <= turns; turn++) {
			setSystemTime(at(turn));
			const text = await Bun.file(filePath).text();
			const { record: edited } = await saveIssueContent(tempDir, id, `${text}\nNote from turn ${turn}.\n`);
			expect(edited.frontmatter.updated).toBe(at(turn).toISOString());
			if ((await a.turnEnd()) === undefined) {
				stopped = true;
				break;
			}
			reminders += 1;
		}

		expect(stopped).toBe(true);
		expect(reminders).toBeGreaterThan(0);
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("running");
		// Once stopped it stays stopped while the agent keeps churning the body.
		setSystemTime(at(turns + 1));
		const text = await Bun.file(filePath).text();
		await saveIssueContent(tempDir, id, `${text}\nOne more note.\n`);
		expect(await a.turnEnd()).toBeUndefined();
	});
});

describe("issues plugin: an issue follows the session that set it running", () => {
	it("an issue no session holds is consumed by nobody: no reminder, no reply, no claim, no stage change", async () => {
		const { a, b } = await twoSessions();
		const queued = await queuedIssue("Trim the release notes");
		const replied = await plainIssue("Pin the toolchain");
		await replyToIssue(tempDir, replied, "Use the version from the lockfile.");

		for (const session of [a, b]) {
			expect(await session.prompt()).toBeUndefined();
			expect(await session.turnEnd()).toBeUndefined();
		}

		expect(await pendingTexts()).toEqual(["Use the version from the lockfile."]);
		expect(await claimOwner(tempDir, queued)).toBeUndefined();
		expect(await claimOwner(tempDir, replied)).toBeUndefined();
		expect((await findIssueById(tempDir, queued))?.frontmatter.stage).toBe("up-next");
		expect((await findIssueById(tempDir, replied))?.frontmatter.stage).toBe("up-next");
	});

	it("replies and a requeue reach the holder at its prompt and turn end, and never the other live session", async () => {
		const { a, b } = await twoSessions();
		const id = await plainIssue("Pin the toolchain");
		await start(a, id, "session-a");

		await replyToIssue(tempDir, id, "Use the version from the lockfile.");
		expect(await b.prompt()).toBeUndefined();
		expect(await b.turnEnd()).toBeUndefined();
		expect(await a.prompt()).toContain("Use the version from the lockfile.");

		// A reply typed while the holder works comes back at its turn end.
		await replyToIssue(tempDir, id, "Keep the patch version.");
		expect(await b.prompt()).toBeUndefined();
		expect(await b.turnEnd()).toBeUndefined();
		expect(await a.turnEnd()).toContain("Keep the patch version.");

		// The agent hands it back; the user requeues it on the board.
		await a.tool({ op: "stage", id, stage: "needs-you" });
		await requeue(id);
		expect(await b.turnEnd()).toBeUndefined();
		expect(await a.turnEnd()).toContain("Pin the toolchain");
		expect(await claimOwner(tempDir, id)).toBe("session-a");
		expect(await pendingTexts()).toEqual([]);
	});

	const departures: Array<{ name: string; leave: (a: Session) => Promise<unknown> }> = [
		{
			name: "goes stale",
			// The holder stops beating; the other session's own events refresh its heartbeat on the new clock.
			leave: async () => setSystemTime(new Date(Date.now() + PRESENCE_STALE_MS + 1_000)),
		},
		{ name: "shuts down", leave: a => a.fire("session_shutdown") },
	];
	for (const departure of departures) {
		it(`once the holder ${departure.name}, the other session gets nothing until it sets the issue running`, async () => {
			const { a, b } = await twoSessions();
			const id = await plainIssue("Pin the toolchain");
			await start(a, id, "session-a");

			await departure.leave(a);
			await replyToIssue(tempDir, id, "Use the version from the lockfile.");
			expect(await b.prompt()).toBeUndefined();
			expect(await b.turnEnd()).toBeUndefined();
			expect(await pendingTexts()).toEqual(["Use the version from the lockfile."]);
			expect(await claimOwner(tempDir, id)).not.toBe("session-b");

			const taken = await b.tool({ op: "stage", id, stage: "running" });
			expect(taken.content).toEqual([{ type: "text", text: `#${id} stage → running` }]);
			expect(await claimOwner(tempDir, id)).toBe("session-b");
			expect(await b.prompt()).toContain("Use the version from the lockfile.");

			// The old holder coming back does not pull the issue away again.
			expect(await a.prompt()).toBeUndefined();
			await replyToIssue(tempDir, id, "Keep the patch version.");
			expect(await a.turnEnd()).toBeUndefined();
			expect(await b.turnEnd()).toContain("Keep the patch version.");
		});
	}

	it("the in-progress reminder covers only issues the session holds with a live claim", async () => {
		const { a, b } = await twoSessions();
		const held = await plainIssue("Split the test shards", "in-progress");
		const others = await plainIssue("Prune stale branches", "in-progress");
		await plainIssue("Rotate the build cache", "in-progress");
		await start(a, held, "session-a");
		await start(b, others, "session-b");

		const forA = await a.turnEnd();
		expect(forA).toContain("Split the test shards");
		expect(forA).not.toContain("Prune stale branches");
		expect(forA).not.toContain("Rotate the build cache");
		const forB = await b.turnEnd();
		expect(forB).toContain("Prune stale branches");
		expect(forB).not.toContain("Split the test shards");
		expect(forB).not.toContain("Rotate the build cache");
	});

	const archives: Array<{ name: string; archive: (a: Session, id: number) => Promise<unknown> }> = [
		{ name: "the archive op", archive: (a, id) => a.tool({ op: "archive", id }) },
		{
			name: "a stage move onto a terminal status",
			archive: async (a, id) => {
				// The status was set to fixed by hand in the active file; the next stage move archives it.
				const filePath = (await findIssueById(tempDir, id))!.filePath;
				const text = await Bun.file(filePath).text();
				await Bun.write(filePath, text.replace(/^status: open$/m, "status: fixed"));
				const moved = await a.tool({ op: "stage", id, stage: "needs-you" });
				expect(moved.details?.archived).toBe(true);
			},
		},
	];
	for (const row of archives) {
		it(`archiving through ${row.name} releases the claim, so the issue's replies reach nobody`, async () => {
			const { a, b } = await twoSessions();
			const id = await plainIssue("Pin the toolchain");
			await start(a, id, "session-a");

			await row.archive(a, id);
			expect(await claimOwner(tempDir, id)).toBeUndefined();

			// A reply reopens the archived issue; with no holder it waits for a prompt.
			await replyToIssue(tempDir, id, "Use the version from the lockfile.");
			for (const session of [a, b]) {
				expect(await session.prompt()).toBeUndefined();
				expect(await session.turnEnd()).toBeUndefined();
			}
			expect(await pendingTexts()).toEqual(["Use the version from the lockfile."]);
		});
	}

	it("a session that moves to a new id drops the old id's claims, and the new id is handed nothing", async () => {
		const { a, b } = await twoSessions();
		const id = await plainIssue("Pin the toolchain");
		await start(a, id, "session-a");

		a.switchTo("session-c");
		await a.fire("session_switch");
		expect(await claimOwner(tempDir, id)).toBeUndefined();

		await replyToIssue(tempDir, id, "Use the version from the lockfile.");
		for (const session of [a, b]) {
			expect(await session.prompt()).toBeUndefined();
			expect(await session.turnEnd()).toBeUndefined();
		}
		expect(await pendingTexts()).toEqual(["Use the version from the lockfile."]);
	});
});
