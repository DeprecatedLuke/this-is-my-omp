/**
 * Knowledge maintenance passes: an isolated pass captures `.omp/knowledge` edits
 * as a scoped native patch (auto-applied on a clean repo, pending on a dirty
 * one, preserved on failure/abort).
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runIsolatedKnowledgePass } from "../src/passes";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed (${exitCode})`);
	}
	return stdout.trim();
}

async function createRepo(seedKnowledge?: { rel: string; content: string }): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-knowledge-pass-"));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
	if (seedKnowledge) await writeKnowledge(repo, seedKnowledge.rel, seedKnowledge.content);
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

async function writeKnowledge(repo: string, rel: string, content: string): Promise<void> {
	const target = path.join(repo, ".omp", "knowledge", rel);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, content);
}

async function readKnowledge(repo: string, rel: string): Promise<string | null> {
	return fs.readFile(path.join(repo, ".omp", "knowledge", rel), "utf8").catch(() => null);
}

async function exists(target: string): Promise<boolean> {
	return fs
		.access(target)
		.then(() => true)
		.catch(() => false);
}

async function isClean(repo: string): Promise<boolean> {
	return (await runGit(repo, ["status", "--porcelain"])) === "";
}

const commitMessage = async () => "chore(knowledge): update .omp/knowledge";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("runIsolatedKnowledgePass", () => {
	it("auto-applies the knowledge patch to a clean repo and reports the created note", async () => {
		const repo = await createRepo();

		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeBuild",
			description: "Build the knowledge base.",
			generateMessage: commitMessage,
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				return { exitCode: 0, aborted: false };
			},
		});

		expect(pass.exitCode).toBe(0);
		expect(pass.patches[0]?.status).toBe("applied");
		expect(await readKnowledge(repo, "repo/layout.md")).toBe("# layout\n");
		expect(pass.changes).toEqual([{ path: "repo/layout.md", kind: "created" }]);
		expect(pass.summary).toContain("applied:");
		expect(await isClean(repo)).toBe(true);
	});

	it("scopes capture to .omp/knowledge so a stray worktree write never reaches the real repo", async () => {
		const repo = await createRepo();

		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeBuild",
			description: "Build the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: commitMessage,
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				await fs.writeFile(path.join(worktree, "stray.txt"), "should not be captured\n");
				return { exitCode: 0, aborted: false };
			},
		});

		expect(pass.patches[0]?.status).toBe("applied");
		expect(await exists(path.join(repo, ".omp", "knowledge", "repo", "layout.md"))).toBe(true);
		expect(await exists(path.join(repo, "stray.txt"))).toBe(false);
		expect(await isClean(repo)).toBe(true);
	});

	it("leaves a pending patch when the target repo is dirty", async () => {
		const repo = await createRepo();
		await fs.writeFile(path.join(repo, "seed.txt"), "seed dirty\n");

		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeUpdate",
			description: "Update the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: commitMessage,
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				return { exitCode: 0, aborted: false };
			},
		});

		expect(pass.patches[0]?.status).toBe("pending");
		expect(pass.patches[0]?.uri).toMatch(/^patch:\/\//);
		expect(await exists(path.join(repo, ".omp", "knowledge", "repo", "layout.md"))).toBe(false);
		expect(pass.summary).toContain("pending:");
		expect(await fs.readFile(path.join(repo, "seed.txt"), "utf8")).toBe("seed dirty\n");
	});

	it("reports a failed worktree pass and preserves its edits as a recovery patch", async () => {
		const repo = await createRepo();

		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeBuild",
			description: "Build the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: commitMessage,
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				return { exitCode: 1, aborted: false };
			},
		});

		expect(pass.exitCode).toBe(1);
		expect(pass.aborted).toBe(false);
		expect(pass.patches[0]).toMatchObject({ status: "pending", recovery: true });
		expect(await exists(path.join(repo, ".omp", "knowledge", "repo", "layout.md"))).toBe(false);
		expect(await isClean(repo)).toBe(true);
	});

	it("reports an aborted worktree pass and preserves its edits as an unapplied recovery patch", async () => {
		const repo = await createRepo();

		const pass = await runIsolatedKnowledgePass({
			cwd: repo,
			taskId: "KnowledgeBuild",
			description: "Build the knowledge base.",
			isolationBackend: "rcopy",
			generateMessage: commitMessage,
			runInWorktree: async worktree => {
				await writeKnowledge(worktree, "repo/layout.md", "# layout\n");
				return { exitCode: 0, aborted: true };
			},
		});

		expect(pass.aborted).toBe(true);
		expect(pass.patches[0]).toMatchObject({ status: "pending", recovery: true });
		expect(await exists(path.join(repo, ".omp", "knowledge", "repo", "layout.md"))).toBe(false);
		expect(await isClean(repo)).toBe(true);
	});
});
