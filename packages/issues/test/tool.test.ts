/**
 * `issues` tool contract: on-disk effects plus the structured `details` the TUI
 * and the parent task card render from. Driven through {@link runIssuesOp}, the
 * same entry the registered tool calls with the session cwd.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claim, claimOwner, PRESENCE_STALE_MS, touchPresence } from "../src/inbox";
import { findIssueById, getIssuesRoot, listIssues } from "../src/store";
import { type IssuesToolDetails, runIssuesOp } from "../src/tool";
import { useTempAgentDir } from "./agent-dir";

useTempAgentDir();

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-tool-"));
});

afterEach(async () => {
	setSystemTime();
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

	it("stage sets, changes and clears the stage, reporting the transition and touching nothing else", async () => {
		const created = await runIssuesOp(tempDir, {
			op: "add",
			category: "infra",
			title: "Flaky deploy",
			body: "Steps to reproduce.\n\n- first\n- second",
			severity: "high",
			location: ["src/deploy.ts:10"],
			extra: { owner: "alice" },
		});
		const id = (created.details as IssuesToolDetails).id!;
		// Everything a stage op must leave alone: all frontmatter but `stage`/`updated`, and the body.
		const untouched = async () => {
			const record = (await findIssueById(tempDir, id))!;
			const { stage: _stage, updated: _updated, ...rest } = record.frontmatter;
			return { rest, body: record.body, filePath: record.filePath };
		};
		const baseline = await untouched();
		expect(baseline.rest).toMatchObject({ severity: "high", owner: "alice" });

		const set = await runIssuesOp(tempDir, { op: "stage", id, stage: "up-next" });
		expect(set.isError).toBeUndefined();
		expect(textOf(set)).toBe(`#${id} stage → up-next`);
		expect(set.details).toMatchObject({
			op: "stage",
			id,
			stage: "up-next",
			previousStage: undefined,
			unchanged: false,
		});
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("up-next");
		expect(await untouched()).toEqual(baseline);

		const again = await runIssuesOp(tempDir, { op: "stage", id, stage: "up-next" });
		expect(again.details).toMatchObject({ stage: "up-next", previousStage: "up-next", unchanged: true });

		const changed = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" });
		expect(textOf(changed)).toBe(`#${id} stage → running`);
		expect(changed.details).toMatchObject({ stage: "running", previousStage: "up-next", unchanged: false });
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("running");

		const cleared = await runIssuesOp(tempDir, { op: "stage", id, stage: "none" });
		expect(textOf(cleared)).toBe(`#${id} stage cleared`);
		expect(cleared.details).toMatchObject({ stage: undefined, previousStage: "running", unchanged: false });
		// Removed from the file, not written as an empty or `none` value.
		const text = await Bun.file(baseline.filePath).text();
		expect(text).not.toMatch(/^stage:/m);
		expect(await untouched()).toEqual(baseline);
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

	it("list with a stage returns only issues on that stage; `none` matches issues with no stage", async () => {
		const rows: Array<{ title: string; stage?: "running" | "up-next" | "needs-you" }> = [
			{ title: "Running work", stage: "running" },
			{ title: "Queued work", stage: "up-next" },
			{ title: "Parked work", stage: "needs-you" },
			{ title: "Unstaged work" },
		];
		for (const { title, stage } of rows) {
			const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title, body: "Body." });
			const id = (created.details as IssuesToolDetails).id!;
			if (stage !== undefined) await runIssuesOp(tempDir, { op: "stage", id, stage });
		}
		// Archived issues carry no stage, so only `none` matches them.
		const done = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Done work", body: "Body." });
		await runIssuesOp(tempDir, { op: "archive", id: (done.details as IssuesToolDetails).id! });

		const listed = async (stage: "running" | "up-next" | "none"): Promise<string[]> => {
			const result = await runIssuesOp(tempDir, { op: "list", stage });
			const details = result.details as IssuesToolDetails;
			expect(details.filters?.stage).toBe(stage);
			expect(textOf(result)).toContain(`stage=${stage}`);
			return details.listing!.map(summary => summary.title).sort();
		};
		expect(await listed("running")).toEqual(["Running work"]);
		expect(await listed("up-next")).toEqual(["Queued work"]);
		expect(await listed("none")).toEqual(["Done work", "Unstaged work"]);
	});

	it("reports unknown ids as an error result instead of throwing", async () => {
		const archived = await runIssuesOp(tempDir, { op: "archive", id: 999 });
		expect(archived.isError).toBe(true);
		expect((archived.details as IssuesToolDetails).error).toMatch(/Issue #999 not found/);
		expect(textOf(archived)).toMatch(/issues archive failed: Issue #999 not found/);

		const unarchived = await runIssuesOp(tempDir, { op: "unarchive", id: 999 });
		expect(unarchived.isError).toBe(true);
		expect((unarchived.details as IssuesToolDetails).error).toMatch(/Issue #999 not found/);

		const staged = await runIssuesOp(tempDir, { op: "stage", id: 999, stage: "running" });
		expect(staged.isError).toBe(true);
		expect((staged.details as IssuesToolDetails).error).toMatch(/Issue #999 not found/);
		expect(textOf(staged)).toMatch(/issues stage failed: Issue #999 not found/);
	});

	it("refuses to stage an archived issue and leaves its file byte-identical", async () => {
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Old finding", body: "B." });
		const id = (created.details as IssuesToolDetails).id!;
		await runIssuesOp(tempDir, { op: "archive", id, reason: "done" });
		const archivedPath = (await findIssueById(tempDir, id))!.filePath;
		const before = await Bun.file(archivedPath).text();
		// A later clock: any rewrite would bump `updated` and change the bytes.
		setSystemTime(new Date("2026-01-02T00:00:00.000Z"));

		const staged = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" });
		expect(staged.isError).toBe(true);
		expect((staged.details as IssuesToolDetails).error).toBe(
			`Issue #${id} is archived; unarchive it before setting a stage.`,
		);
		expect(textOf(staged)).toBe(
			`issues stage failed: Issue #${id} is archived; unarchive it before setting a stage.`,
		);
		expect(await Bun.file(archivedPath).text()).toBe(before);
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

describe("issues tool: stage running claims the issue for the calling session", () => {
	const SELF = "4f1c2a9e";
	const PEER = "9d0e7b31";

	async function addRunnable(): Promise<number> {
		const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Flaky deploy", body: "B." });
		return (created.details as IssuesToolDetails).id!;
	}

	it("a main session claims a free issue; a call without a session id (a subagent) claims nothing", async () => {
		const id = await addRunnable();

		await runIssuesOp(tempDir, { op: "stage", id, stage: "running" });
		expect(await claimOwner(tempDir, id)).toBeUndefined();

		const started = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: SELF });
		expect(textOf(started)).toBe(`#${id} stage → running`);
		expect(await claimOwner(tempDir, id)).toBe(SELF);
	});

	it("an issue another live session holds is still staged, keeps its holder, and the result warns", async () => {
		const id = await addRunnable();
		await touchPresence(tempDir, PEER);
		expect(await claim(tempDir, id, PEER)).toBe(true);

		const started = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: SELF });

		expect(started.isError).toBeUndefined();
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("running");
		expect(textOf(started)).toContain(`#${id} is held by another live session (${PEER.slice(0, 6)})`);
		expect(await claimOwner(tempDir, id)).toBe(PEER);
	});

	it("an issue held by a session whose heartbeat went stale is taken over without a warning", async () => {
		const id = await addRunnable();
		await touchPresence(tempDir, PEER);
		expect(await claim(tempDir, id, PEER)).toBe(true);
		setSystemTime(new Date(Date.now() + PRESENCE_STALE_MS + 1_000));

		const started = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: SELF });

		expect(textOf(started)).toBe(`#${id} stage → running`);
		expect(await claimOwner(tempDir, id)).toBe(SELF);
	});
});
