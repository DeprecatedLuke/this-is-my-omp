/**
 * `git_checkpoint` tool contract: the two-stage flow against real temp git repos,
 * plus the registration surface the host depends on (name, approval, discoverable
 * load mode, model-facing description).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as commitMessageGenerator from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";
import { type CheckpointSession, createGitCheckpointTool, runGitCheckpoint } from "../src/tool";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode}`);
	}
	return stdout.trim();
}

/** Dirty single-repo workspace: one tracked edit, HEAD at the initial commit. */
async function createDirtyRepo(): Promise<{ repo: string; head: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-checkpoint-tool-"));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "edit\n");
	return { repo, head: await runGit(repo, ["rev-parse", "HEAD"]) };
}

function createSession(cwd: string, registry?: ModelRegistry): CheckpointSession {
	return {
		cwd,
		modelRegistry: registry ?? ({} as ModelRegistry),
		settings: Settings.isolated(),
		sessionId: "test-session",
	};
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("git_checkpoint tool", () => {
	it("registers as a discoverable write tool whose description states both stages", () => {
		// A typo in any of these silently drops the tool or mis-gates its approval.
		const tool = createGitCheckpointTool(zod);

		expect(tool.name).toBe("git_checkpoint");
		expect(tool.approval).toBe("write");
		expect(tool.loadMode).toBe("discoverable");
		expect(tool.description).toContain("repos");
		expect(tool.renderCall).toBeFunction();
		expect(tool.renderResult).toBeFunction();
	});

	it("stage one lists the dirty repo and commits nothing", async () => {
		const { repo, head } = await createDirtyRepo();
		const session = createSession(repo);

		for (const params of [{}, { repos: [] }]) {
			const result = await runGitCheckpoint(params, session);
			const details = result.details!;

			expect(details.stage).toBe("listed");
			expect(details.dirty.map(entry => [entry.label, entry.changedFiles])).toEqual([[".", 1]]);
			expect(textOf(result)).toContain("Detected repos with changes:\n  . (1 file)");
			// Listing is not a failure, and it must not have touched history.
			expect(result.isError).toBeUndefined();
			expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
		}
	});

	it("stage two rejects an unknown name and commits nothing", async () => {
		const { repo, head } = await createDirtyRepo();
		const session = createSession(repo);

		const result = await runGitCheckpoint({ repos: ["packages/lib"] }, session);
		const details = result.details!;

		expect(details.stage).toBe("unmatched");
		expect(details.unmatched).toEqual(["packages/lib"]);
		expect(textOf(result)).toContain("No dirty repo matches: packages/lib");
		expect(textOf(result)).toContain("  . (1 file)");
		expect(result.isError).toBe(true);
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
	});

	it("stage two commits the repo named exactly as listed", async () => {
		const { repo, head } = await createDirtyRepo();
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("test: checkpoint changes");

		const result = await runGitCheckpoint({ repos: ["."] }, createSession(repo));
		const details = result.details!;
		const entry = details.entries?.[0];

		expect(details.stage).toBe("committed");
		expect(entry).toMatchObject({
			label: ".",
			status: "committed",
			filesChanged: 1,
			message: "test: checkpoint changes",
		});
		expect(entry?.sha).toBeTruthy();
		expect(result.isError).toBeUndefined();
		expect(await runGit(repo, ["log", "-1", "--format=%s"])).toBe("test: checkpoint changes");
		expect(await runGit(repo, ["rev-parse", "HEAD"])).not.toBe(head);
	});

	it("surfaces a failed commit as a tool error without advancing history", async () => {
		const { repo, head } = await createDirtyRepo();
		vi.spyOn(commitMessageGenerator, "generateCommitMessage").mockResolvedValue("");

		const result = await runGitCheckpoint({ repos: ["."] }, createSession(repo));

		expect(result.details?.entries?.map(entry => entry.status)).toEqual(["failed"]);
		expect(textOf(result)).toContain("Could not generate a commit message.");
		expect(result.isError).toBe(true);
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
	});

	it("reports a clean workspace without touching history", async () => {
		const { repo } = await createDirtyRepo();
		await runGit(repo, ["commit", "-am", "edit"]);

		const result = await runGitCheckpoint({}, createSession(repo));

		expect(result.details?.stage).toBe("clean");
		expect(textOf(result)).toContain("Nothing to commit — all repos are clean.");
		expect(result.isError).toBeUndefined();
	});
});
