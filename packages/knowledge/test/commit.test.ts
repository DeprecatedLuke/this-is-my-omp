/**
 * `commitKnowledgeFiles` contract: stage and commit ONLY `<cwd>/.omp/knowledge`,
 * leave every other dirty path untouched, report `clean`/`no-git` instead of
 * throwing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitKnowledgeFiles } from "../src/commit";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return stdout.trim();
}

async function initRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-commit-knowledge-"));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await runGit(repo, ["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "outside.txt"), "base\n");
	await fs.mkdir(path.join(repo, ".omp", "knowledge"), { recursive: true });
	await fs.writeFile(path.join(repo, ".omp", "knowledge", "note.md"), "base\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("commitKnowledgeFiles", () => {
	test("commits only the .omp/knowledge subtree, leaving other dirty files untouched", async () => {
		const repo = await initRepo();
		const headBefore = await runGit(repo, ["rev-parse", "HEAD"]);

		await fs.writeFile(path.join(repo, "outside.txt"), "dirty outside\n");
		await fs.writeFile(path.join(repo, ".omp", "knowledge", "note.md"), "updated knowledge\n");

		const result = await commitKnowledgeFiles(repo, { sourceTitle: "/knowledge compact" });

		expect(result.committed).toBe(true);
		expect(result.reason).toBeUndefined();

		const headAfter = await runGit(repo, ["rev-parse", "HEAD"]);
		expect(headAfter).not.toBe(headBefore);
		expect(result.sha).toBeDefined();
		expect(headAfter.startsWith(result.sha as string)).toBe(true);

		const changedFiles = (await runGit(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]))
			.split("\n")
			.filter(Boolean);
		expect(changedFiles).toEqual([".omp/knowledge/note.md"]);

		expect(await runGit(repo, ["log", "-1", "--pretty=%s"])).toBe("chore(knowledge): update .omp/knowledge");
		expect((await runGit(repo, ["log", "-1", "--pretty=%b"])).trim()).toBe("Source: /knowledge compact");

		// The outside file is still modified but was never staged or committed.
		expect((await runGit(repo, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean)).toEqual([]);
		expect((await runGit(repo, ["diff", "--name-only"])).split("\n").filter(Boolean)).toEqual(["outside.txt"]);
	});

	test("returns reason 'clean' when the knowledge subtree has no changes", async () => {
		const repo = await initRepo();
		const headBefore = await runGit(repo, ["rev-parse", "HEAD"]);
		await fs.writeFile(path.join(repo, "outside.txt"), "dirty outside\n");

		const result = await commitKnowledgeFiles(repo, {});

		expect(result).toEqual({ committed: false, reason: "clean" });
		expect(await runGit(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
		expect((await runGit(repo, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean)).toEqual([]);
		expect((await runGit(repo, ["diff", "--name-only"])).split("\n").filter(Boolean)).toEqual(["outside.txt"]);
	});

	test("returns reason 'no-git' outside any repository instead of throwing", async () => {
		const plain = await fs.mkdtemp(path.join(os.tmpdir(), "omp-commit-knowledge-nogit-"));
		tempDirs.push(plain);

		const result = await commitKnowledgeFiles(plain, {});

		expect(result).toEqual({ committed: false, reason: "no-git" });
	});
});
