/**
 * `# Knowledge` prompt-section contract: absent/empty roots emit nothing, the
 * index renders one line per category and one URL row per note in
 * `loadKnowledgeSummaries` order, and the frontmatter side effect is reflected
 * in the row it derives.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { getKnowledgeRoot } from "../src/knowledge-index";
import { renderKnowledgeSection } from "../src/prompt";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-prompt-"));
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

describe("renderKnowledgeSection", () => {
	it("emits nothing when the knowledge root is missing or holds no valid notes", async () => {
		expect(await renderKnowledgeSection(tempDir)).toBeUndefined();

		await fs.mkdir(getKnowledgeRoot(tempDir), { recursive: true });
		expect(await renderKnowledgeSection(tempDir)).toBeUndefined();

		// Files that normalizeKnowledgePath rejects must not produce a heading.
		await writeNote("loose.md", "# Loose\n");
		await writeNote("nested/deep/note.md", "# Deep\n");
		await writeNote(".hidden/note.md", "# Hidden\n");
		await writeNote("runtime/.hidden.md", "# Hidden file\n");
		await writeNote("runtime/notes.txt", "not markdown\n");

		expect(await renderKnowledgeSection(tempDir)).toBeUndefined();
	});

	it("renders one category heading and one knowledge:// row per note, sorted like the index", async () => {
		await writeNote("beta/zeta.md", "---\ndescription: beta, zeta, Beta note\n---\n\n# Zeta\n");
		await writeNote("alpha/zebra.md", "---\ndescription: alpha, zebra, Zebra note\n---\n\n# Zebra\n");
		await writeNote("alpha/armadillo.md", "---\ndescription: alpha, armadillo, Armadillo note\n---\n\n# Armadillo\n");

		expect(await renderKnowledgeSection(tempDir)).toBe(
			[
				"# Knowledge",
				"alpha",
				"- `knowledge://alpha/armadillo.md`: alpha, armadillo, Armadillo note",
				"- `knowledge://alpha/zebra.md`: alpha, zebra, Zebra note",
				"beta",
				"- `knowledge://beta/zeta.md`: beta, zeta, Beta note",
			].join("\n"),
		);
	});

	it("reflects a body-derived description on the same call and stays identical across calls", async () => {
		const notePath = await writeNote(
			"runtime/background-jobs.md",
			"# Background Jobs\n\n- Completion deliveries wait for pending async work.\n",
		);

		const first = await renderKnowledgeSection(tempDir);
		expect(first).toBe(
			[
				"# Knowledge",
				"runtime",
				"- `knowledge://runtime/background-jobs.md`: runtime, background jobs, Completion deliveries wait, pending async work",
			].join("\n"),
		);

		// The index write-back is visible on disk and matches the rendered row.
		const { frontmatter } = parseFrontmatter(await Bun.file(notePath).text(), { source: notePath });
		expect(frontmatter.description).toBe("runtime, background jobs, Completion deliveries wait, pending async work");

		const afterFirst = await Bun.file(notePath).text();
		const second = await renderKnowledgeSection(tempDir);
		expect(second).toBe(first);
		expect(await Bun.file(notePath).text()).toBe(afterFirst);
	});
});
