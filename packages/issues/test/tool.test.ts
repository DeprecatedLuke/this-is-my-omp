/**
 * `issues` tool contract: on-disk effects plus the structured `details` the TUI
 * and the parent task card render from. Driven through {@link runIssuesOp}, the
 * same entry the registered tool calls with the session cwd.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findIssueById, getIssuesRoot, listIssues } from "../src/store";
import { type IssuesToolDetails, runIssuesOp } from "../src/tool";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-tool-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("issues tool", () => {
	it("add writes under .omp/issues/<category>/ and returns rendering details", async () => {
		const result = await runIssuesOp(tempDir, {
			op: "add",
			category: "security",
			title: "Reset password leak",
			body: "Description of the bug.\n\n## Fix\n1. Validate.",
			severity: "high",
			location: ["src/auth/reset.ts:10-20"],
			extra: { confidence: 0.85 },
		});

		const details = result.details as IssuesToolDetails;
		expect(details.op).toBe("add");
		expect(details.id).toBe(1);
		expect(details.category).toBe("security");
		expect(details.severity).toBe("high");
		expect(details.url).toBe(`issues://${details.filename}`);
		expect(details.bodyPreview).toContain("Description of the bug");
		expect(details.location).toBe("src/auth/reset.ts:10-20");
		expect(details.confidence).toBe(0.85);

		const filePath = path.join(getIssuesRoot(tempDir), "security", details.filename!);
		expect(await Bun.file(filePath).exists()).toBe(true);
		expect(textOf(result)).toContain(`Created #1 issues://${details.filename}`);
	});

	it("archive then unarchive moves the file, round-trips status, and reports the transition", async () => {
		const created = await runIssuesOp(tempDir, {
			op: "add",
			category: "security",
			title: "Initial finding",
			body: "Body A.",
			severity: "medium",
		});
		const id = (created.details as IssuesToolDetails).id!;

		const archived = await runIssuesOp(tempDir, { op: "archive", id, reason: "fixed in #321" });
		const archiveDetails = archived.details as IssuesToolDetails;
		expect(archiveDetails.archived).toBe(true);
		expect(archiveDetails.unchanged).toBe(false);
		expect(archiveDetails.previousStatus).toBe("open");
		expect(archiveDetails.previousArchived).toBe(false);
		const record = await findIssueById(tempDir, id);
		expect(record?.archived).toBe(true);
		expect(record?.frontmatter.archive_reason).toBe("fixed in #321");

		const restored = await runIssuesOp(tempDir, { op: "unarchive", id });
		const restoreDetails = restored.details as IssuesToolDetails;
		expect(restoreDetails.archived).toBe(false);
		expect(restoreDetails.previousArchived).toBe(true);
		const back = await findIssueById(tempDir, id);
		expect(back?.archived).toBe(false);
		expect(back?.frontmatter.status).toBe("open");
	});

	it("list returns scope-aware markdown plus the filters it ran with", async () => {
		await runIssuesOp(tempDir, {
			op: "add",
			category: "security",
			title: "Critical leak",
			body: "Body.",
			severity: "critical",
		});
		await runIssuesOp(tempDir, {
			op: "add",
			category: "correctness",
			title: "Minor nit",
			body: "Body.",
			severity: "low",
		});

		const listAll = await runIssuesOp(tempDir, { op: "list" });
		const listAllText = textOf(listAll);
		expect(listAllText).toContain("active+archive");
		expect(listAllText).toContain("Critical leak");
		expect(listAllText).toContain("Minor nit");
		expect((listAll.details as IssuesToolDetails).listing).toHaveLength(2);

		const listCritical = await runIssuesOp(tempDir, { op: "list", severity: "critical" });
		const listCriticalText = textOf(listCritical);
		expect(listCriticalText).toContain("Critical leak");
		expect(listCriticalText).not.toContain("Minor nit");
		expect((listCritical.details as IssuesToolDetails).filters).toEqual({
			category: undefined,
			archived: undefined,
			severity: "critical",
			status: undefined,
			query: undefined,
			limit: undefined,
		});
	});

	it("reports unknown ids as an error result instead of throwing", async () => {
		const archived = await runIssuesOp(tempDir, { op: "archive", id: 999 });
		expect(archived.isError).toBe(true);
		expect((archived.details as IssuesToolDetails).error).toMatch(/Issue #999 not found/);
		expect(textOf(archived)).toMatch(/issues archive failed: Issue #999 not found/);

		const unarchived = await runIssuesOp(tempDir, { op: "unarchive", id: 999 });
		expect(unarchived.isError).toBe(true);
		expect((unarchived.details as IssuesToolDetails).error).toMatch(/Issue #999 not found/);
	});

	it("rejects an invalid category and leaves no file behind", async () => {
		const result = await runIssuesOp(tempDir, {
			op: "add",
			category: "../escape",
			title: "Bad bucket",
			body: "Body.",
		});
		expect(result.isError).toBe(true);
		expect((result.details as IssuesToolDetails).error).toMatch(/Invalid issue category/);
		expect(await Bun.file(path.join(tempDir, ".omp", "issues", ".next-id")).exists()).toBe(false);
	});

	it("add writes a valid report link into the frontmatter and rejects a malformed one without a file", async () => {
		const created = await runIssuesOp(tempDir, {
			op: "add",
			category: "infra",
			title: "Flaky deploy",
			body: "Body.",
			report: "report://personal/flaky-deploy",
		});
		expect(created.isError).toBeFalsy();
		const { id } = created.details as IssuesToolDetails;
		expect((await findIssueById(tempDir, id!))?.frontmatter.report).toBe("report://personal/flaky-deploy");

		const rejected = await runIssuesOp(tempDir, {
			op: "add",
			category: "infra",
			title: "Dead link",
			body: "Body.",
			report: "reports.example.com/personal/flaky-deploy",
		});
		expect(rejected.isError).toBe(true);
		expect((rejected.details as IssuesToolDetails).error).toMatch(/invalid report/);
		expect((await listIssues(tempDir)).map(summary => summary.title)).toEqual(["Flaky deploy"]);
	});
});
