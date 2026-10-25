/**
 * Knowledge-note index contract: path normalization, URL encoding, retrieval
 * tag descriptions, the frontmatter upgrade (and its read-only mode), and the
 * root fingerprint used to invalidate exporter state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import {
	deriveKnowledgeDescription,
	ensureKnowledgeDescriptionContent,
	fingerprintKnowledgeRoot,
	getKnowledgeRoot,
	knowledgeUrlForPath,
	loadKnowledgeSummaries,
	normalizeKnowledgePath,
} from "../src/knowledge-index";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-index-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeNote(relativePath: string, content: string): Promise<string> {
	const target = path.join(getKnowledgeRoot(tempDir), ...relativePath.split("/"));
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, content);
	return target;
}

describe("normalizeKnowledgePath", () => {
	it("accepts exactly <category>/<topic>.md, normalizing separators and surrounding space", () => {
		expect(normalizeKnowledgePath("runtime/background-jobs.md")).toBe("runtime/background-jobs.md");
		expect(normalizeKnowledgePath("runtime\\background-jobs.md")).toBe("runtime/background-jobs.md");
		expect(normalizeKnowledgePath("  runtime/background-jobs.md  ")).toBe("runtime/background-jobs.md");
		expect(normalizeKnowledgePath("runtime/Background-Jobs.MD")).toBe("runtime/Background-Jobs.MD");
	});

	it("rejects paths that are not a two-segment markdown note", () => {
		const invalid = [
			"",
			"topic.md",
			"runtime/nested/topic.md",
			"../topic.md",
			"runtime/../topic.md",
			".hidden/topic.md",
			"runtime/.hidden.md",
			"runtime/topic.txt",
			"runtime/topic.md\0",
		];
		for (const candidate of invalid) {
			expect(normalizeKnowledgePath(candidate)).toBeUndefined();
		}
	});
});

describe("knowledgeUrlForPath", () => {
	it("builds knowledge:// URLs and preserves opaque $/ : note names", () => {
		expect(knowledgeUrlForPath("runtime/background-jobs.md")).toBe("knowledge://runtime/background-jobs.md");
		expect(knowledgeUrlForPath("sdk/generator-$x:y$.md")).toBe("knowledge://sdk/generator-$x:y$.md");
	});

	it("percent-encodes segment characters the URL grammar cannot carry raw", () => {
		expect(knowledgeUrlForPath("my notes/a b.md")).toBe("knowledge://my%20notes/a%20b.md");
	});

	it("throws for a path that could escape the knowledge root", () => {
		expect(() => knowledgeUrlForPath("../secret.md")).toThrow("Invalid knowledge path: ../secret.md");
	});
});

describe("deriveKnowledgeDescription", () => {
	it("combines the category, topic, headings, and durable prose into retrieval tags", () => {
		expect(
			deriveKnowledgeDescription(
				"runtime/background-jobs.md",
				"# Background Jobs\n\n- Completion deliveries wait for pending async work.\n",
			),
		).toBe("runtime, background jobs, Completion deliveries wait, pending async work");
	});

	it("ignores headings and tags inside fenced code blocks", () => {
		expect(
			deriveKnowledgeDescription(
				"runtime/background-jobs.md",
				"```\n# Not a heading\n- not a tag\n```\n# Real Heading\nRun tests after worker changes.\n",
			),
		).toBe("runtime, background jobs, Real Heading, tests, worker changes");
	});

	it("caps an over-long description at 512 characters with an ellipsis", () => {
		const description = deriveKnowledgeDescription("runtime/background-jobs.md", "x".repeat(600));
		expect(description.length).toBeLessThanOrEqual(512);
		expect(description.endsWith("…")).toBe(true);
	});
});

describe("ensureKnowledgeDescriptionContent", () => {
	it("adds a description frontmatter block without touching the body", () => {
		const body = "# Background Jobs\n\n- Completion deliveries wait for pending async work.\n";
		const result = ensureKnowledgeDescriptionContent("runtime/background-jobs.md", body);

		expect(result.changed).toBe(true);
		expect(result.description).toBe("runtime, background jobs, Completion deliveries wait, pending async work");
		const parsed = parseFrontmatter(result.content, { source: "runtime/background-jobs.md" });
		expect(parsed.frontmatter.description).toBe(result.description);
		expect(parsed.body).toBe(body.trim());
	});

	it("leaves an already tag-based description byte-identical", () => {
		const content = "---\ndescription: runtime, background jobs\n---\n\n# Background Jobs\n";
		const result = ensureKnowledgeDescriptionContent("runtime/background-jobs.md", content);

		expect(result).toEqual({ content, description: "runtime, background jobs", changed: false });
	});

	it("upgrades a prose description to retrieval tags while preserving body and other metadata", () => {
		const content = [
			"---",
			"title: Smoke Tests",
			"description: Run omp --smoke-test after binary worker changes.",
			"---",
			"",
			"# Smoke Tests",
			"",
			"- Run `omp --smoke-test` after binary worker changes.",
			"- Keep worker entries in build-binary.ts.",
			"",
		].join("\n");
		const result = ensureKnowledgeDescriptionContent("workflows/smoke-tests.md", content);

		expect(result.changed).toBe(true);
		expect(result.description).toBe(
			"workflows, smoke tests, omp --smoke-test, binary worker changes, worker entries in build-binary.ts",
		);
		const parsed = parseFrontmatter(result.content, { source: "workflows/smoke-tests.md" });
		expect(parsed.frontmatter.title).toBe("Smoke Tests");
		expect(parsed.frontmatter.description).toBe(result.description);
		expect(parsed.body).toBe(
			"# Smoke Tests\n\n- Run `omp --smoke-test` after binary worker changes.\n- Keep worker entries in build-binary.ts.",
		);
	});

	it("never rewrites a file whose frontmatter fences are malformed", () => {
		const content = "---\ndescription: runtime, background jobs\n\n# No closing fence\n";
		const result = ensureKnowledgeDescriptionContent("runtime/background-jobs.md", content);

		expect(result.changed).toBe(false);
		expect(result.content).toBe(content);
	});

	it("is idempotent: a second pass over its own output changes nothing", () => {
		const first = ensureKnowledgeDescriptionContent(
			"runtime/background-jobs.md",
			"# Background Jobs\n\n- Completion deliveries wait for pending async work.\n",
		);
		const second = ensureKnowledgeDescriptionContent("runtime/background-jobs.md", first.content);

		expect(second.changed).toBe(false);
		expect(second.content).toBe(first.content);
		expect(second.description).toBe(first.description);
	});
});

describe("loadKnowledgeSummaries", () => {
	it("reports notes sorted by category and topic, upgrading frontmatter on disk", async () => {
		await writeNote("zeta/background-jobs.md", "# Background Jobs\n\n- Durable fact.\n");
		await writeNote("alpha/zebra.md", "---\ndescription: alpha, zebra\n---\n\n# Zebra\n");
		await writeNote("alpha/armadillo.md", "# Armadillo\n\n- Other fact.\n");
		// Neither of these is a valid <category>/<topic>.md note.
		await writeNote("loose.md", "# Loose\n");
		await writeNote("alpha/deep/nested.md", "# Nested\n");

		const summaries = await loadKnowledgeSummaries({ cwd: tempDir });

		expect(summaries.map(summary => summary.path)).toEqual([
			"alpha/armadillo.md",
			"alpha/zebra.md",
			"zeta/background-jobs.md",
		]);
		expect(summaries.map(summary => [summary.category, summary.topic])).toEqual([
			["alpha", "armadillo.md"],
			["alpha", "zebra.md"],
			["zeta", "background-jobs.md"],
		]);

		const upgraded = await Bun.file(path.join(getKnowledgeRoot(tempDir), "alpha", "armadillo.md")).text();
		const parsed = parseFrontmatter(upgraded, { source: "alpha/armadillo.md" });
		expect(parsed.frontmatter.description).toBe("alpha, armadillo, Other fact");
		expect(parsed.body).toBe("# Armadillo\n\n- Other fact.");
	});

	it("reports descriptions without writing when autoUpdate is false", async () => {
		const content = "# Background Jobs\n\n- Durable fact.\n";
		const notePath = await writeNote("zeta/background-jobs.md", content);

		const summaries = await loadKnowledgeSummaries({ cwd: tempDir, autoUpdate: false });

		expect(summaries).toEqual([
			{
				category: "zeta",
				topic: "background-jobs.md",
				path: "zeta/background-jobs.md",
				description: "zeta, background jobs, Durable fact",
			},
		]);
		expect(await Bun.file(notePath).text()).toBe(content);
	});
});

describe("fingerprintKnowledgeRoot", () => {
	it("is stable for an unchanged tree and changes with note content or membership", async () => {
		const empty = await fingerprintKnowledgeRoot(tempDir);
		expect(await fingerprintKnowledgeRoot(tempDir)).toBe(empty);

		const notePath = await writeNote("runtime/background-jobs.md", "# Background Jobs\n\n- Fact one.\n");
		const withNote = await fingerprintKnowledgeRoot(tempDir);
		expect(withNote).not.toBe(empty);
		expect(await fingerprintKnowledgeRoot(tempDir)).toBe(withNote);

		await Bun.write(notePath, "# Background Jobs\n\n- Fact two.\n");
		const changed = await fingerprintKnowledgeRoot(tempDir);
		expect(changed).not.toBe(withNote);
		expect(await fingerprintKnowledgeRoot(tempDir)).toBe(changed);

		await fs.rm(notePath);
		expect(await fingerprintKnowledgeRoot(tempDir)).toBe(empty);
	});
});
