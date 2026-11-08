/**
 * Plugin hand-off: which main session is handed board work, and what a hand-off
 * does to the issue. Driven through the real plugin with a minimal host per
 * session: it runs the plugin's event handlers in registration order, holds its
 * tool, and carries the session context the handlers read.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { boardOwner, claimOwner, listQueued, listReplies, PRESENCE_STALE_MS, setQueued } from "../src/inbox";
import issuesPlugin from "../src/index";
import { addIssue, findIssueById, replyToIssue, saveIssueContent } from "../src/store";
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

/** An active `up-next` issue the user queued on this machine. */
async function queuedIssue(title: string): Promise<number> {
	const { record } = await addIssue(tempDir, { category: "infra", title, body: "B.", extra: { stage: "up-next" } });
	await setQueued(tempDir, record.id, true);
	return record.id;
}

/**
 * Two live main sessions in one checkout. `owner` takes the board the way a real
 * session does — by being handed the first queued issue at a turn end — so the
 * lease is the plugin's own, and `firstId` is the issue it now holds.
 */
async function ownerAndOther(): Promise<{ owner: Session; other: Session; firstId: number }> {
	const owner = openSession("session-a");
	const other = openSession("session-b");
	await owner.fire("session_start");
	await other.fire("session_start");
	const firstId = await queuedIssue("Rotate the build cache");
	expect(await owner.turnEnd()).toContain("Rotate the build cache");
	expect(await boardOwner(tempDir)).toBe("session-a");
	return { owner, other, firstId };
}

describe("issues plugin: hand-off marks the issue running", () => {
	it("a reply delivered at prompt time moves its issue to running", async () => {
		const session = openSession("session-a");
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		await replyToIssue(tempDir, record.id, "Please retry on arm.");
		expect((await findIssueById(tempDir, record.id))?.frontmatter.stage).toBe("up-next");

		const result = await session.fire("before_agent_start", { systemPrompt: [], reason: "prompt" });

		expect(result).toMatchObject({ message: { content: expect.stringContaining("Please retry on arm.") } });
		expect((await findIssueById(tempDir, record.id))?.frontmatter.stage).toBe("running");
	});

	it("turn-end hand-off writes running once, so later turns leave the file alone and the stall guard ends the loop", async () => {
		const session = openSession("session-a");
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Flaky deploy",
			body: "B.",
			extra: { stage: "up-next" },
		});
		await setQueued(tempDir, record.id, true);

		setSystemTime(at(1));
		const first = await session.fire("session_stop");
		expect(first).toMatchObject({ continue: true, additionalContext: expect.stringContaining("Flaky deploy") });
		const handedOff = await findIssueById(tempDir, record.id);
		expect(handedOff?.frontmatter.stage).toBe("running");
		expect(handedOff?.frontmatter.updated).toBe(at(1).toISOString());
		const fileAfterHandOff = await Bun.file(record.filePath).text();

		// The agent ignores the queue. Each turn runs on a later clock, so any
		// rewrite would bump `updated`; the file must stay byte-identical and
		// the reminders must stop instead of looping forever.
		const turns = 10;
		let reminders = 0;
		for (let turn = 2; turn <= turns; turn++) {
			setSystemTime(at(turn));
			const result = await session.fire("session_stop");
			expect(await Bun.file(record.filePath).text()).toBe(fileAfterHandOff);
			if (result === undefined) break;
			reminders += 1;
		}
		expect(reminders).toBeLessThan(turns - 1);
		// Still in flight: the issue keeps its queue mark.
		expect([...(await listQueued(tempDir))]).toEqual([record.id]);
	});

	it("an agent that rewrites its running issue's body every turn still gets a bounded number of reminders", async () => {
		const session = openSession("session-a");
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Flaky deploy",
			body: "B.",
			extra: { stage: "up-next" },
		});
		await setQueued(tempDir, record.id, true);

		// Before each turn end the agent appends a note through the issue file
		// write path, on a later clock, so the body and `updated` change every
		// turn while stage and status stay put.
		const turns = 12;
		let reminders = 0;
		let stopped = false;
		for (let turn = 1; turn <= turns; turn++) {
			setSystemTime(at(turn));
			const text = await Bun.file(record.filePath).text();
			const { record: edited } = await saveIssueContent(tempDir, record.id, `${text}\nNote from turn ${turn}.\n`);
			expect(edited.frontmatter.updated).toBe(at(turn).toISOString());
			const result = await session.fire("session_stop");
			if (result === undefined) {
				stopped = true;
				break;
			}
			reminders += 1;
		}

		expect(stopped).toBe(true);
		expect(reminders).toBeGreaterThan(0);
		expect((await findIssueById(tempDir, record.id))?.frontmatter.stage).toBe("running");
		// Once stopped it stays stopped while the agent keeps churning the body.
		setSystemTime(at(turns + 1));
		const text = await Bun.file(record.filePath).text();
		await saveIssueContent(tempDir, record.id, `${text}\nOne more note.\n`);
		expect(await session.fire("session_stop")).toBeUndefined();
	});
});

describe("issues plugin: one session owns the board", () => {
	it("only the owner is handed new queued work and replies; another live session gets neither and claims nothing", async () => {
		const { owner, other } = await ownerAndOther();
		const queued = await queuedIssue("Trim the release notes");
		const { record } = await addIssue(tempDir, { category: "infra", title: "Pin the toolchain", body: "B." });
		await replyToIssue(tempDir, record.id, "Use the version from the lockfile.");

		expect(await other.prompt()).toBeUndefined();
		expect(await other.turnEnd()).toBeUndefined();
		expect(await claimOwner(tempDir, queued)).toBeUndefined();
		expect(await claimOwner(tempDir, record.id)).toBeUndefined();
		expect((await listReplies(tempDir)).map(reply => reply.text)).toEqual(["Use the version from the lockfile."]);
		expect((await findIssueById(tempDir, queued))?.frontmatter.stage).toBe("up-next");

		expect(await owner.prompt()).toContain("Use the version from the lockfile.");
		expect(await owner.turnEnd()).toContain("Trim the release notes");
		expect(await claimOwner(tempDir, queued)).toBe("session-a");
		expect(await claimOwner(tempDir, record.id)).toBe("session-a");
	});

	it("once the owner shuts down, the other session takes the board, its new work and the owner's dropped claims", async () => {
		const { owner, other, firstId } = await ownerAndOther();
		const queued = await queuedIssue("Trim the release notes");
		expect(await other.turnEnd()).toBeUndefined();

		await owner.fire("session_shutdown");

		const reminder = await other.turnEnd();
		expect(reminder).toContain("Trim the release notes");
		expect(reminder).toContain("Rotate the build cache");
		expect(await boardOwner(tempDir)).toBe("session-b");
		expect(await claimOwner(tempDir, queued)).toBe("session-b");
		expect(await claimOwner(tempDir, firstId)).toBe("session-b");
	});

	it("once the owner's heartbeat goes stale, the other session takes over the lease and the owner's claims", async () => {
		const { other, firstId } = await ownerAndOther();
		const queued = await queuedIssue("Trim the release notes");
		expect(await other.turnEnd()).toBeUndefined();

		// The owner stops beating; the other session's turn end refreshes its own heartbeat on the new clock.
		setSystemTime(new Date(Date.now() + PRESENCE_STALE_MS + 1_000));

		const reminder = await other.turnEnd();
		expect(reminder).toContain("Trim the release notes");
		expect(reminder).toContain("Rotate the build cache");
		expect(await boardOwner(tempDir)).toBe("session-b");
		expect(await claimOwner(tempDir, queued)).toBe("session-b");
		expect(await claimOwner(tempDir, firstId)).toBe("session-b");
	});

	it("an issue the non-owner started keeps coming back to it, never to the owner", async () => {
		const { owner, other } = await ownerAndOther();
		const { record } = await addIssue(tempDir, { category: "infra", title: "Pin the toolchain", body: "B." });
		const started = await other.tool({ op: "stage", id: record.id, stage: "running" });
		expect(started.isError).toBeUndefined();
		expect(await claimOwner(tempDir, record.id)).toBe("session-b");
		await replyToIssue(tempDir, record.id, "Use the version from the lockfile.");

		expect(await owner.prompt()).toBeUndefined();
		expect(await other.prompt()).toContain("Use the version from the lockfile.");
		// The reply left the issue queued: its holder is reminded, the owner is not.
		expect(await other.turnEnd()).toContain("Pin the toolchain");
		expect((await owner.turnEnd()) ?? "").not.toContain("Pin the toolchain");
		expect(await claimOwner(tempDir, record.id)).toBe("session-b");
	});

	it("the lease stays free while a session has no work it may take, even when work held by another live session is pending", async () => {
		const idle = openSession("session-a");
		const holder = openSession("session-b");
		await idle.fire("session_start");
		await holder.fire("session_start");
		expect(await idle.prompt()).toBeUndefined();
		expect(await idle.turnEnd()).toBeUndefined();
		expect(await boardOwner(tempDir)).toBeUndefined();

		const { record } = await addIssue(tempDir, { category: "infra", title: "Pin the toolchain", body: "B." });
		await holder.tool({ op: "stage", id: record.id, stage: "running" });
		await replyToIssue(tempDir, record.id, "Use the version from the lockfile.");

		expect(await idle.prompt()).toBeUndefined();
		expect(await idle.turnEnd()).toBeUndefined();
		expect(await boardOwner(tempDir)).toBeUndefined();
		// The holder is handed its own issue without taking the board either.
		expect(await holder.prompt()).toContain("Use the version from the lockfile.");
		expect(await boardOwner(tempDir)).toBeUndefined();
	});

	it("a session that joins is handed free work alongside the live owner; before joining it is not", async () => {
		const { other } = await ownerAndOther();
		const queued = await queuedIssue("Trim the release notes");
		expect(await other.turnEnd()).toBeUndefined();
		expect(await claimOwner(tempDir, queued)).toBeUndefined();

		const joined = await other.tool({ op: "join" });
		expect(joined.details).toMatchObject({ op: "join", parallel: true, owner: "session-a" });

		expect(await other.turnEnd()).toContain("Trim the release notes");
		expect(await claimOwner(tempDir, queued)).toBe("session-b");
		const { record } = await addIssue(tempDir, { category: "infra", title: "Pin the toolchain", body: "B." });
		await replyToIssue(tempDir, record.id, "Use the version from the lockfile.");
		expect(await other.prompt()).toContain("Use the version from the lockfile.");
		// Joining shares the work; the owner keeps the lease.
		expect(await boardOwner(tempDir)).toBe("session-a");
	});

	it("a session that moves to a new id drops the old id's lease and claims", async () => {
		const { owner, other, firstId } = await ownerAndOther();

		owner.switchTo("session-c");
		await owner.fire("session_switch");

		expect(await boardOwner(tempDir)).toBeUndefined();
		expect(await claimOwner(tempDir, firstId)).toBeUndefined();
		expect(await other.turnEnd()).toContain("Rotate the build cache");
		expect(await boardOwner(tempDir)).toBe("session-b");
	});
});
