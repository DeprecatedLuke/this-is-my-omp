/**
 * Saved-session exporter contract: `--last` window parsing and the observable
 * bookkeeping of a backfill run — matched/skipped/empty/failed counters, the
 * durable export state file, and knowledge-fingerprint invalidation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { RunSessionKnowledgeAgentResult } from "../src/agent-pass";
import {
	type BuildFromSessionsDeps,
	type BuildFromSessionsResult,
	buildFromSessions,
	parseLastDurationMs,
} from "../src/exporter";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const MOCK_MODEL = { provider: "mock", id: "mock-model" } as unknown as Model<Api>;

let tempDir: string;
let statePath: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-exporter-"));
	statePath = path.join(tempDir, "knowledge-exports.json");
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

interface SessionFixtureOptions {
	cwd?: string;
	modified?: Date;
	messages?: boolean;
}

/** A real session JSONL on disk plus the `SessionInfo` the lister would return for it. */
async function createSession(id: string, options: SessionFixtureOptions = {}): Promise<SessionInfo> {
	const cwd = options.cwd ?? tempDir;
	const filePath = path.join(tempDir, `${id}.jsonl`);
	const lines: unknown[] = [
		{ type: "session", version: 3, id, timestamp: new Date(NOW.getTime() - 2 * DAY).toISOString(), cwd },
	];
	if (options.messages !== false) {
		lines.push({
			type: "message",
			id: `${id}-m1`,
			parentId: null,
			timestamp: new Date(NOW.getTime() - 2 * DAY).toISOString(),
			message: { role: "user", content: [{ type: "text", text: `fact from ${id}` }], timestamp: 0 },
		});
	}
	await Bun.write(filePath, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	const stat = await fs.stat(filePath);
	return {
		path: filePath,
		id,
		cwd,
		created: new Date(NOW.getTime() - 2 * DAY),
		modified: options.modified ?? new Date(NOW.getTime() - DAY),
		messageCount: options.messages === false ? 0 : 1,
		size: stat.size,
		firstMessage: `fact from ${id}`,
		allMessagesText: `fact from ${id}`,
	};
}

function deps(overrides: Partial<BuildFromSessionsDeps> = {}): BuildFromSessionsDeps {
	return {
		settings: Settings.isolated(),
		cwd: tempDir,
		availableModels: [MOCK_MODEL],
		getApiKey: async () => "test-key",
		listSessions: async () => [],
		exportSession: async () => ({ completed: true, committed: false }),
		statePath,
		now: () => NOW,
		cwdExists: async () => true,
		...overrides,
	};
}

function run(args: Parameters<typeof buildFromSessions>[0], overrides: Partial<BuildFromSessionsDeps> = {}) {
	return buildFromSessions(args, deps(overrides));
}

async function readState(): Promise<{
	version: number;
	knowledgeFingerprint?: string;
	sessions: Record<string, Record<string, unknown>>;
}> {
	return (await Bun.file(statePath).json()) as {
		version: number;
		knowledgeFingerprint?: string;
		sessions: Record<string, Record<string, unknown>>;
	};
}

const EXPORTED: RunSessionKnowledgeAgentResult = { completed: true, committed: true, sha: "abc1234" };

describe("parseLastDurationMs", () => {
	it("parses durations, bare day counts, all, and the 30d default", () => {
		const cases: Array<[string | undefined, number]> = [
			["30d", 30 * DAY],
			["72h", 72 * 60 * 60 * 1000],
			["2m", 2 * 60 * 1000],
			["1w", 7 * DAY],
			["500ms", 500],
			["7", 7 * DAY],
			["ALL", Number.POSITIVE_INFINITY],
			[" all ", Number.POSITIVE_INFINITY],
			[undefined, 30 * DAY],
		];
		for (const [input, expected] of cases) {
			expect(parseLastDurationMs(input)).toBe(expected);
		}
	});

	it("rejects values that are not a supported duration", () => {
		for (const input of ["soon", "30dd", "-1d", "1.5d", ""]) {
			expect(() => parseLastDurationMs(input)).toThrow(`Invalid --last value "${input}"`);
		}
	});
});

describe("buildFromSessions", () => {
	it("exports only sessions inside the --last window, and everything for all", async () => {
		const old = await createSession("old", { modified: new Date(NOW.getTime() - 40 * DAY) });
		const recent = await createSession("recent", { modified: new Date(NOW.getTime() - DAY) });
		const sessions = [old, recent];

		const windowed = await run(
			{ last: "30d" },
			{
				listSessions: async () => sessions,
				exportSession: async () => EXPORTED,
			},
		);

		expect(windowed).toMatchObject({ matched: 1, processed: 1, exported: 1 });
		expect(Object.keys((await readState()).sessions)).toEqual(["recent"]);

		statePath = path.join(tempDir, "all-exports.json");
		const everything = await run(
			{ last: "all" },
			{
				listSessions: async () => sessions,
				exportSession: async () => EXPORTED,
			},
		);
		expect(everything).toMatchObject({ matched: 2, processed: 2, exported: 2, committed: 2 });
	});

	it("skips a session already exported at the same fingerprint unless --force is given", async () => {
		const session = await createSession("s1");
		let exports = 0;
		const exportSession = async (): Promise<RunSessionKnowledgeAgentResult> => {
			exports += 1;
			return EXPORTED;
		};

		const first = await run({}, { listSessions: async () => [session], exportSession });
		expect(first).toMatchObject({ matched: 1, processed: 1, exported: 1, skippedAlreadyExported: 0 });
		expect(exports).toBe(1);

		const second = await run({}, { listSessions: async () => [session], exportSession });
		expect(second).toMatchObject({ processed: 0, exported: 0, skippedAlreadyExported: 1 });
		expect(exports).toBe(1);

		const forced = await run({ force: true }, { listSessions: async () => [session], exportSession });
		expect(forced).toMatchObject({ processed: 1, exported: 1, skippedAlreadyExported: 0 });
		expect(exports).toBe(2);
	});

	it("records an empty session without invoking the exporter, and skips it next run", async () => {
		const session = await createSession("empty", { messages: false });
		let exports = 0;

		const first = await run(
			{},
			{
				listSessions: async () => [session],
				exportSession: async () => {
					exports += 1;
					return EXPORTED;
				},
			},
		);

		expect(first).toMatchObject({ matched: 1, processed: 0, empty: 1, exported: 0, failed: 0 });
		expect(exports).toBe(0);
		const record = (await readState()).sessions.empty;
		expect(record).toMatchObject({ sessionId: "empty", status: "empty", committed: false });

		const second = await run({}, { listSessions: async () => [session] });
		expect(second).toMatchObject({ empty: 0, skippedAlreadyExported: 1 });
	});

	it("skips a session whose recorded cwd no longer exists", async () => {
		const missingCwd = path.join(tempDir, "moved-away");
		const session = await createSession("s1", { cwd: missingCwd });
		let exports = 0;

		const result = await run(
			{},
			{
				listSessions: async () => [session],
				cwdExists: async cwd => cwd !== missingCwd,
				exportSession: async () => {
					exports += 1;
					return EXPORTED;
				},
			},
		);

		expect(result).toMatchObject({ matched: 1, skippedMissingCwd: 1, processed: 0, exported: 0 });
		expect(exports).toBe(0);
		expect((await readState()).sessions.s1).toBeUndefined();
	});

	it("counts an extraction failure without caching it, so a later run retries", async () => {
		const session = await createSession("s1");
		const progress: string[] = [];

		const failed = await run(
			{},
			{
				listSessions: async () => [session],
				exportSession: async () => undefined,
				onProgress: line => progress.push(line),
			},
		);

		expect(failed).toMatchObject({ matched: 1, processed: 1, failed: 1, exported: 0 });
		expect(progress.some(line => line.includes("failed: knowledge extraction failed"))).toBe(true);
		expect((await readState()).sessions.s1).toBeUndefined();

		const retried = await run({}, { listSessions: async () => [session] });
		expect(retried).toMatchObject({ processed: 1, exported: 1, failed: 0 });
	});

	it("writes the export state record and knowledge fingerprint", async () => {
		const session = await createSession("s1");

		const result: BuildFromSessionsResult = await run(
			{},
			{ listSessions: async () => [session], exportSession: async () => EXPORTED },
		);
		expect(result.committed).toBe(1);

		const state = await readState();
		expect(state.version).toBe(1);
		expect(state.knowledgeFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(state.sessions.s1).toMatchObject({
			sessionId: "s1",
			path: path.resolve(session.path),
			cwd: tempDir,
			modifiedMs: session.modified.getTime(),
			size: session.size,
			messageCount: 1,
			status: "exported",
			committed: true,
			sha: "abc1234",
			exportedAt: NOW.toISOString(),
		});
	});

	it("invalidates cached sessions when the knowledge root changes underneath the state", async () => {
		const session = await createSession("s1");
		let exports = 0;
		const exportSession = async (): Promise<RunSessionKnowledgeAgentResult> => {
			exports += 1;
			return EXPORTED;
		};

		await run({}, { listSessions: async () => [session], exportSession });
		expect(exports).toBe(1);

		await fs.mkdir(path.join(tempDir, ".omp", "knowledge", "runtime"), { recursive: true });
		await Bun.write(path.join(tempDir, ".omp", "knowledge", "runtime", "jobs.md"), "# Jobs\n\n- Durable fact.\n");

		const progress: string[] = [];
		const rebuilt = await run(
			{},
			{
				listSessions: async () => [session],
				exportSession,
				onProgress: line => progress.push(line),
			},
		);

		expect(rebuilt).toMatchObject({ processed: 1, exported: 1, skippedAlreadyExported: 0 });
		expect(exports).toBe(2);
		expect(progress.some(line => line.includes("Knowledge files changed since the last export"))).toBe(true);
	});
});
