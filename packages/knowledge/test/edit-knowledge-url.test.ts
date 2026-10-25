/**
 * `edit` tool integration for `knowledge://`: file-backed edits land through
 * the plugin handler (raw and percent-encoded note names alike), symlinks may
 * not escape the knowledge root, and plain filesystem edits still work.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computeFileHash } from "@oh-my-pi/pi-tui/tools/hashline-format";
import { getKnowledgeRoot } from "../src/knowledge-index";
import { KnowledgeProtocolHandler } from "../src/protocol";

const KNOWLEDGE_FILE = "testing/edit-url.md";
const BASE_CONTENT = "---\ndescription: testing, edit url\n---\n\n# Edit URL\n\n- Original durable fact.\n";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	} as unknown as ToolSession;
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

function knowledgeAbsPath(cwd: string): string {
	return path.join(getKnowledgeRoot(cwd), ...KNOWLEDGE_FILE.split("/"));
}

describe("edit tool knowledge:// support", () => {
	let tempDir: string;
	let savedEditVariant: string | undefined;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		// Pin to the default (hashline) edit mode regardless of the host env.
		savedEditVariant = Bun.env.PI_EDIT_VARIANT;
		delete Bun.env.PI_EDIT_VARIANT;
		InternalUrlRouter.resetForTests();
		InternalUrlRouter.instance().register(new KnowledgeProtocolHandler());
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-knowledge-url-"));
		await Bun.write(knowledgeAbsPath(tempDir), BASE_CONTENT);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		InternalUrlRouter.resetForTests();
		if (savedEditVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
		else Bun.env.PI_EDIT_VARIANT = savedEditVariant;
	});

	/** Resolve the live knowledge content and build a hashline op that replaces its body line. */
	async function buildEditInput(): Promise<string> {
		const resource = await InternalUrlRouter.instance().resolve(`knowledge://${KNOWLEDGE_FILE}`, { cwd: tempDir });
		const tag = computeFileHash(resource.content);
		return `[knowledge://${KNOWLEDGE_FILE}#${tag}]\nPUT 7.=7:\n+- Edited durable fact.`;
	}

	it("rewrites a knowledge file through the knowledge:// URL handler", async () => {
		const tool = new EditTool(createSession(tempDir));
		expect(tool.mode).toBe("hashline");

		const result = await tool.execute("call-1", { input: await buildEditInput() });

		expect(resultText(result)).toContain(`[knowledge://${KNOWLEDGE_FILE}#`);
		const onDisk = await Bun.file(knowledgeAbsPath(tempDir)).text();
		expect(onDisk).toContain("- Edited durable fact.");
		expect(onDisk).not.toContain("- Original durable fact.");
	});

	it("edits opaque note names in raw and percent-encoded URL forms", async () => {
		const relativePath = "sdk/generator-$x:y$.md";
		const rawUri = "knowledge://sdk/generator-$x:y$.md";
		const encodedUri = "knowledge://sdk/generator-%24x%3Ay%24.md";
		const notePath = path.join(getKnowledgeRoot(tempDir), ...relativePath.split("/"));
		const noteContent = "---\ndescription: sdk, generator\n---\n\n# Generator\n\n- Opaque name.\n";
		await Bun.write(notePath, noteContent);

		const tool = new EditTool(createSession(tempDir), "hashline");
		const rawTag = computeFileHash(await Bun.file(notePath).text());
		await tool.execute("call-opaque-raw", {
			input: `[${rawUri}#${rawTag}]\nPUT 7.=7:\n+- Edited through raw URI.`,
		});
		expect(await Bun.file(notePath).text()).toContain("- Edited through raw URI.");

		const encodedTag = computeFileHash(await Bun.file(notePath).text());
		await tool.execute("call-opaque-encoded", {
			input: `[${encodedUri}#${encodedTag}]\nPUT 7.=7:\n+- Edited through encoded URI.`,
		});
		const editedContent = await Bun.file(notePath).text();
		expect(editedContent).toContain("- Edited through encoded URI.");
		expect(editedContent).not.toContain("- Edited through raw URI.");
	});

	it("rejects knowledge edits through a category symlink that escapes the knowledge root", async () => {
		const knowledgeRoot = getKnowledgeRoot(tempDir);
		const outsidePath = path.join(tempDir, "outside-topic.md");
		const escapedCategory = path.join(knowledgeRoot, "escaped");
		await fs.mkdir(knowledgeRoot, { recursive: true });
		await fs.writeFile(outsidePath, BASE_CONTENT);
		await fs.symlink(path.dirname(outsidePath), escapedCategory, "dir");
		const before = await fs.readFile(outsidePath, "utf8");
		const tag = computeFileHash(before);
		const input = `[knowledge://escaped/${path.basename(outsidePath)}#${tag}]\nPUT 7.=7:\n+- Must not edit outside knowledge root.`;

		const result = await new EditTool(createSession(tempDir)).execute("call-escape", { input });

		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("knowledge:// URL escapes knowledge root");
		expect(await fs.readFile(outsidePath, "utf8")).toBe(before);
	});

	it("edits a knowledge file via its filesystem path under .omp/knowledge", async () => {
		const tool = new EditTool(createSession(tempDir));
		const relPath = path.join(".omp", "knowledge", ...KNOWLEDGE_FILE.split("/"));
		const tag = computeFileHash(await Bun.file(knowledgeAbsPath(tempDir)).text());
		const input = `[${relPath}#${tag}]\nPUT 7.=7:\n+- Edited durable fact.`;

		const result = await tool.execute("call-fs", { input });

		expect(resultText(result)).toContain(".omp/knowledge/");
		const onDisk = await Bun.file(knowledgeAbsPath(tempDir)).text();
		expect(onDisk).toContain("- Edited durable fact.");
		expect(onDisk).not.toContain("- Original durable fact.");
	});

	it("leaves ordinary filesystem hashline edits on the filesystem path", async () => {
		const filePath = path.join(tempDir, "plain.md");
		await Bun.write(filePath, "# Plain\n\n- keep me\n");
		const tag = computeFileHash(await Bun.file(filePath).text());
		const input = `[${filePath}#${tag}]\nPUT 3.=3:\n+- changed me`;

		const result = await new EditTool(createSession(tempDir)).execute("call-plain", { input });

		expect(resultText(result)).toContain("[plain.md#");
		const onDisk = await Bun.file(filePath).text();
		expect(onDisk).toContain("- changed me");
		expect(onDisk).not.toContain("- keep me");
	});
});
