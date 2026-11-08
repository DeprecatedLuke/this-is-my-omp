/**
 * Test isolation for the user-local issue inbox. The inbox lives under omp's
 * agent dir, so every test that queues, claims or replies MUST point that dir
 * at a throwaway location — otherwise it writes into the real
 * `~/.omp/agent/issues-inbox`.
 */
import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

/** Env keys `setAgentDir` rewrites; restored verbatim after each test. */
const AGENT_DIR_ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/**
 * Give every test in the calling file its own temp agent dir, then restore the
 * process env and omp's dir resolver exactly as they were.
 */
export function useTempAgentDir(): void {
	let saved: Partial<Record<(typeof AGENT_DIR_ENV_KEYS)[number], string>> = {};
	let agentDir = "";

	beforeEach(async () => {
		saved = {};
		for (const key of AGENT_DIR_ENV_KEYS) {
			if (process.env[key] !== undefined) saved[key] = process.env[key];
		}
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-agent-"));
		setAgentDir(agentDir);
		if (path.resolve(getAgentDir()) !== path.resolve(agentDir)) {
			throw new Error(`agent dir not redirected: ${getAgentDir()}`);
		}
	});

	afterEach(async () => {
		for (const key of AGENT_DIR_ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		await fs.rm(agentDir, { recursive: true, force: true });
	});
}
