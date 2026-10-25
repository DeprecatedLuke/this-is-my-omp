/**
 * `knowledge://` protocol contract: listing, note reads/writes, containment for
 * `locate` (including symlink escapes), the writable file-backed scheme spec,
 * and the prompt doc that advertises the scheme.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { getKnowledgeRoot } from "../src/knowledge-index";
import { KnowledgeProtocolHandler } from "../src/protocol";

let tempDir: string;
let handler: KnowledgeProtocolHandler;

function root(): string {
	return getKnowledgeRoot(tempDir);
}

async function writeNote(relativePath: string, content: string): Promise<string> {
	const target = path.join(root(), ...relativePath.split("/"));
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, content);
	return target;
}

function writeResultText(result: undefined | { content: Array<{ type: string; text?: string }> }): string {
	if (result === undefined) return "";
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-protocol-"));
	InternalUrlRouter.resetForTests();
	handler = new KnowledgeProtocolHandler();
	InternalUrlRouter.instance().register(handler);
});

afterEach(async () => {
	InternalUrlRouter.resetForTests();
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("KnowledgeProtocolHandler listings", () => {
	it("lists all notes at knowledge:// and one category at knowledge://<category>", async () => {
		await writeNote("runtime/background-jobs.md", "---\ndescription: runtime, background jobs\n---\n\n# Jobs\n");
		await writeNote("testing/smoke.md", "---\ndescription: testing, smoke\n---\n\n# Smoke\n");

		const all = await InternalUrlRouter.instance().resolve("knowledge://", { cwd: tempDir });
		const runtime = await InternalUrlRouter.instance().resolve("knowledge://runtime", { cwd: tempDir });

		expect(all.content).toContain("knowledge://runtime/background-jobs.md");
		expect(all.content).toContain("knowledge://testing/smoke.md");
		expect(runtime.content).toContain("knowledge://runtime/background-jobs.md");
		expect(runtime.content).not.toContain("knowledge://testing/smoke.md");

		expect(all.immutable).toBe(true);
		expect(all.sourcePath).toBe(path.resolve(root()));
		expect(runtime.sourcePath).toBe(path.resolve(root(), "runtime"));
	});

	it("states explicitly when a category or the whole root is empty", async () => {
		const emptyRoot = await InternalUrlRouter.instance().resolve("knowledge://", { cwd: tempDir });
		const emptyCategory = await InternalUrlRouter.instance().resolve("knowledge://missing", { cwd: tempDir });

		expect(emptyRoot.content).toContain("No project knowledge files.");
		expect(emptyCategory.content).toContain("No project knowledge files in category `missing`.");
	});

	it("lists and resolves opaque note names containing $ and : verbatim", async () => {
		const relativePath = "sdk/generator-$x:y$.md";
		const noteContent = "---\ndescription: sdk, generator\n---\n\n# Generator\n\n- Opaque name.\n";
		await writeNote(relativePath, noteContent);

		const listing = await InternalUrlRouter.instance().resolve("knowledge://", { cwd: tempDir });
		expect(listing.content).toContain("knowledge://sdk/generator-$x:y$.md");

		const raw = await InternalUrlRouter.instance().resolve("knowledge://sdk/generator-$x:y$.md", { cwd: tempDir });
		const encoded = await InternalUrlRouter.instance().resolve("knowledge://sdk/generator-%24x%3Ay%24.md", {
			cwd: tempDir,
		});
		expect(raw.content).toBe(noteContent);
		expect(encoded.content).toBe(noteContent);
	});
});

describe("KnowledgeProtocolHandler note reads", () => {
	it("reads a note raw, exposing its real path, content type, and write hint", async () => {
		const notePath = await writeNote(
			"runtime/background-jobs.md",
			"---\ndescription: runtime, background jobs\n---\n\n# Background Jobs\n\n- Durable fact.\n",
		);

		const resource = await InternalUrlRouter.instance().resolve("knowledge://runtime/background-jobs.md", {
			cwd: tempDir,
		});

		expect(resource.content).toContain("# Background Jobs");
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.sourcePath).toBe(await fs.realpath(notePath));
		expect(resource.notes?.[0]).toBe("Use write path knowledge://<category>/<topic>.md to update project knowledge.");
	});

	it("rejects traversal and non-note paths", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("knowledge://runtime/nested/topic.md", { cwd: tempDir }),
		).rejects.toThrow("knowledge:// path must be <category>/<topic>.md");
		await expect(InternalUrlRouter.instance().resolve("knowledge://../secret.md", { cwd: tempDir })).rejects.toThrow(
			"knowledge:// category must be a non-hidden relative path segment",
		);
	});
});

describe("KnowledgeProtocolHandler writes", () => {
	it("normalizes retrieval-tag frontmatter while preserving the body and adding a trailing newline", async () => {
		const result = await handler.write(
			parseInternalUrl("knowledge://runtime/background-jobs.md"),
			"# Background Jobs\r\n\r\n- Completion deliveries wait for pending async work.\r\n",
			{ cwd: tempDir },
		);

		expect(writeResultText(result)).toContain("Wrote knowledge://runtime/background-jobs.md");
		const written = await Bun.file(path.join(root(), "runtime", "background-jobs.md")).text();
		expect(written).not.toContain("\r");
		expect(written.endsWith("\n")).toBe(true);
		expect(written.endsWith("\n\n")).toBe(false);

		const parsed = parseFrontmatter(written, { source: "knowledge://runtime/background-jobs.md" });
		expect(parsed.frontmatter.description).toBe(
			"runtime, background jobs, Completion deliveries wait, pending async work",
		);
		expect(parsed.body).toBe("# Background Jobs\n\n- Completion deliveries wait for pending async work.");
	});

	it("keeps unknown frontmatter fields while adding the description", async () => {
		await handler.write(
			parseInternalUrl("knowledge://runtime/background-jobs.md"),
			"---\ntitle: Background Jobs\n---\n\n# Background Jobs\n\n- Durable fact.\n",
			{ cwd: tempDir },
		);

		const written = await Bun.file(path.join(root(), "runtime", "background-jobs.md")).text();
		const parsed = parseFrontmatter(written, { source: "knowledge://runtime/background-jobs.md" });
		expect(parsed.frontmatter.title).toBe("Background Jobs");
		expect(parsed.frontmatter.description).toBe("runtime, background jobs, Durable fact");
		expect(parsed.body).toBe("# Background Jobs\n\n- Durable fact.");
	});

	it("rejects empty content and writes to listing URLs", async () => {
		await expect(
			handler.write(parseInternalUrl("knowledge://runtime/background-jobs.md"), "   \n", { cwd: tempDir }),
		).rejects.toThrow("Knowledge content cannot be empty.");
		await expect(
			handler.write(parseInternalUrl("knowledge://runtime"), "# No file", { cwd: tempDir }),
		).rejects.toThrow("knowledge:// write requires a file path");
	});
});

describe("KnowledgeProtocolHandler locate", () => {
	it("locates an existing note and returns null for listings", async () => {
		const notePath = await writeNote("runtime/background-jobs.md", "# Jobs\n");

		expect(await handler.locate(parseInternalUrl("knowledge://runtime/background-jobs.md"), { cwd: tempDir })).toBe(
			await fs.realpath(notePath),
		);
		expect(await handler.locate(parseInternalUrl("knowledge://"), { cwd: tempDir })).toBeNull();
		expect(await handler.locate(parseInternalUrl("knowledge://runtime"), { cwd: tempDir })).toBeNull();
	});

	it("returns the intended path for a missing note only when create is requested, without creating it", async () => {
		const target = path.join(root(), "runtime", "background-jobs.md");

		expect(
			await handler.locate(parseInternalUrl("knowledge://runtime/background-jobs.md"), { cwd: tempDir }),
		).toBeNull();
		expect(
			await handler.locate(
				parseInternalUrl("knowledge://runtime/background-jobs.md"),
				{ cwd: tempDir },
				{ create: true },
			),
		).toBe(path.join(path.resolve(root()), "runtime", "background-jobs.md"));
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("rejects a category symlink that escapes the knowledge root", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-protocol-outside-"));
		try {
			const outsideNote = path.join(outside, "topic.md");
			await Bun.write(outsideNote, "# Outside\n");
			await fs.mkdir(root(), { recursive: true });
			await fs.symlink(outside, path.join(root(), "escaped"), "dir");

			await expect(
				handler.locate(parseInternalUrl("knowledge://escaped/topic.md"), { cwd: tempDir }),
			).rejects.toThrow("knowledge:// URL escapes knowledge root");
			await expect(
				InternalUrlRouter.instance().resolve("knowledge://escaped/topic.md", { cwd: tempDir }),
			).rejects.toThrow("knowledge:// URL escapes knowledge root");
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("KnowledgeProtocolHandler spec and prompt", () => {
	it("declares a writable, file-backed, frontmatter-hiding scheme that supports file edits", () => {
		expect(handler.scheme).toBe("knowledge");
		expect(handler.spec.backing).toBe("file");
		expect(handler.spec.hideFrontmatter).toBe(true);
		expect(handler.spec.write?.fileEdits).toBe(true);
		expect(handler.spec.write?.via).toBe("handler");
	});

	it("advertises the knowledge:// URL grammar in the prompt doc", () => {
		const doc = handler.promptDoc({
			skillUriAccess: false,
			ruleCount: 0,
			securityEnabled: false,
			settingsApproval: false,
		});
		expect(doc).toContain("`knowledge://`: project knowledge notes under `.omp/knowledge`");
		expect(doc).toContain("knowledge://<category>/<topic>.md");
	});
});
