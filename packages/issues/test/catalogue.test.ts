/**
 * `§ Filed Issues` section contract: every subagent granted the `issues` tool
 * must see what is already catalogued — including archived and settled entries
 * — so it never re-files a decision the project already made.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { filedIssuesCatalogue, filedIssuesSection } from "../src/catalogue";
import { addIssue, archiveIssue } from "../src/store";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-catalogue-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("filed issues catalogue", () => {
	it("says so when nothing is filed yet", async () => {
		expect(await filedIssuesCatalogue(tempDir)).toBe("_No issues filed yet._");
		const section = await filedIssuesSection(tempDir);
		expect(section).toContain("§ Filed Issues");
		expect(section).toContain("_No issues filed yet._");
	});

	it("lists active and archived entries with their issues:// URLs", async () => {
		await addIssue(tempDir, { category: "security", title: "Allow-all egress", body: "Wide open." });
		const archived = await addIssue(tempDir, {
			category: "correctness",
			title: "Settled duplicate",
			body: "Matched an existing report.",
		});
		await archiveIssue(tempDir, archived.record.id, { reason: "duplicate of #1" });

		const section = await filedIssuesSection(tempDir);
		expect(section).toContain("Allow-all egress");
		expect(section).toContain("Settled duplicate");
		expect(section).toContain("(archived)");
		expect(section).toContain("issues://");
		// The de-dup rule the old core prompt carried travels with the section.
		expect(section).toContain("NEVER re-file it");
		expect(section).toContain("`write` tool");
	});
});
