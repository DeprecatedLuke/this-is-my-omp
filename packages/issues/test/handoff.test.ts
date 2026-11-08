/**
 * Plugin hand-off: when a main session takes an issue — a reply delivered at
 * prompt time, or queued work handed out at turn end — the plugin marks it
 * `running` exactly once. Driven through the real plugin handlers with a
 * minimal host: only the hooks and the session context the handlers read.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { listQueued, setQueued } from "../src/inbox";
import issuesPlugin from "../src/index";
import { addIssue, findIssueById, replyToIssue } from "../src/store";
import { useTempAgentDir } from "./agent-dir";

useTempAgentDir();

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-handoff-"));
});

afterEach(async () => {
	setSystemTime();
	await fs.rm(tempDir, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

/** Load the plugin against a host that only records its event handlers. */
function loadPlugin(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		logger: { warn() {}, debug() {} },
		registerTool() {},
		registerMessageRenderer() {},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getActiveTools: () => [],
	};
	issuesPlugin(pi as unknown as ExtensionAPI);
	return handlers;
}

function mainContext(cwd: string): ExtensionContext {
	return {
		cwd,
		agent: { kind: "main" },
		sessionManager: { getSessionId: () => "session-a" },
		getAsyncJobSnapshot: () => null,
	} as unknown as ExtensionContext;
}

function at(day: number): Date {
	return new Date(Date.UTC(2026, 0, day));
}

describe("issues plugin: hand-off marks the issue running", () => {
	it("a reply delivered at prompt time moves its issue to running", async () => {
		const handlers = loadPlugin();
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		await replyToIssue(tempDir, record.id, "Please retry on arm.");
		expect((await findIssueById(tempDir, record.id))?.frontmatter.stage).toBe("up-next");

		const result = await handlers.get("before_agent_start")!(
			{ systemPrompt: [], reason: "prompt" },
			mainContext(tempDir),
		);

		expect(result).toMatchObject({ message: { content: expect.stringContaining("Please retry on arm.") } });
		expect((await findIssueById(tempDir, record.id))?.frontmatter.stage).toBe("running");
	});

	it("turn-end hand-off writes running once, so later turns leave the file alone and the stall guard ends the loop", async () => {
		const handlers = loadPlugin();
		const sessionStop = handlers.get("session_stop")!;
		const ctx = mainContext(tempDir);
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Flaky deploy",
			body: "B.",
			extra: { stage: "up-next" },
		});
		await setQueued(tempDir, record.id, true);

		setSystemTime(at(1));
		const first = await sessionStop({}, ctx);
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
			const result = await sessionStop({}, ctx);
			expect(await Bun.file(record.filePath).text()).toBe(fileAfterHandOff);
			if (result === undefined) break;
			reminders += 1;
		}
		expect(reminders).toBeLessThan(turns - 1);
		// Still in flight: the issue keeps its queue mark.
		expect([...(await listQueued(tempDir))]).toEqual([record.id]);
	});
});
