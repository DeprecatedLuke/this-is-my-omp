/**
 * `issues` tool contract: on-disk effects plus the structured `details` the TUI
 * and the parent task card render from. Driven through {@link runIssuesOp}, the
 * same entry the registered tool calls with the session cwd.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claim, claimOwner, inboxDir, listReplies, PRESENCE_STALE_MS, touchPresence } from "../src/inbox";
import { findIssueById, getIssuesRoot, listIssues, NEEDS_STAGE_ONLY, replyToIssue } from "../src/store";
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
		const rows: Array<{ title: string; stage?: "running" | "up-next" | "needs-you"; needs?: string }> = [
			{ title: "Running work", stage: "running" },
			{ title: "Queued work", stage: "up-next" },
			{ title: "Parked work", stage: "needs-you", needs: "Approve the plan?" },
			{ title: "Unstaged work" },
		];
		for (const { title, stage, needs } of rows) {
			const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title, body: "Body." });
			const id = (created.details as IssuesToolDetails).id!;
			if (stage !== undefined) await runIssuesOp(tempDir, { op: "stage", id, stage, needs });
		}
		// Archived issues carry no stage, so only `none` matches them.
		const done = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Done work", body: "Body." });
		await runIssuesOp(tempDir, { op: "archive", id: (done.details as IssuesToolDetails).id!, reason: "Shipped." });

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
		const archived = await runIssuesOp(tempDir, { op: "archive", id: 999, reason: "Shipped." });
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

	const badReasons: Array<{ name: string; reason: string | undefined }> = [
		{ name: "missing", reason: undefined },
		{ name: "empty", reason: "" },
		{ name: "whitespace-only", reason: " \n\t " },
	];
	for (const { name, reason } of badReasons) {
		it(`archive with a ${name} reason is an error result and leaves the issue active`, async () => {
			const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Open", body: "Body." });
			const id = (created.details as IssuesToolDetails).id!;
			const params = { op: "archive", id, reason } as Parameters<typeof runIssuesOp>[1];
			const result = await runIssuesOp(tempDir, params);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("Archive rejected: closing an issue needs closing remarks");
			const record = await findIssueById(tempDir, id);
			expect(record?.archived).toBe(false);
			expect(record?.frontmatter.status).toBe("open");
		});
	}

	it("archive stores the closing remarks trimmed", async () => {
		const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Open", body: "Body." });
		const id = (created.details as IssuesToolDetails).id!;
		await runIssuesOp(tempDir, { op: "archive", id, reason: "  Fixed in #8.\n" });
		expect((await findIssueById(tempDir, id))?.frontmatter.archive_reason).toBe("Fixed in #8.");
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

	it("stage needs-you records the trimmed `needs` text on the issue and reports it", async () => {
		const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Flaky deploy", body: "B." });
		const id = (created.details as IssuesToolDetails).id!;

		const staged = await runIssuesOp(tempDir, {
			op: "stage",
			id,
			stage: "needs-you",
			needs: "  Approve moving CI to the arm runner?\n",
		});

		expect(staged.isError).toBeUndefined();
		expect(textOf(staged)).toBe(`#${id} stage → needs-you\nNeeds: Approve moving CI to the arm runner?`);
		expect(staged.details).toMatchObject({ stage: "needs-you", needs: "Approve moving CI to the arm runner?" });
		const record = await findIssueById(tempDir, id);
		expect(record?.frontmatter.stage).toBe("needs-you");
		expect(record?.frontmatter.needs).toBe("Approve moving CI to the arm runner?");
	});

	const deployStagings: Array<{ name: string; needs?: string; text: string; needsAfter?: string }> = [
		{
			name: "with the roll as `needs`",
			needs: "Roll api v2.3.1 to prod",
			text: "stage → awaiting-deploy\nNeeds: Roll api v2.3.1 to prod",
			needsAfter: "Roll api v2.3.1 to prod",
		},
		{ name: "without `needs`", text: "stage → awaiting-deploy" },
	];
	for (const row of deployStagings) {
		it(`stage awaiting-deploy ${row.name} is accepted and reports exactly the text it carries`, async () => {
			const created = await runIssuesOp(tempDir, {
				op: "add",
				category: "infra",
				title: "Flaky deploy",
				body: "B.",
			});
			const id = (created.details as IssuesToolDetails).id!;

			const staged = await runIssuesOp(tempDir, { op: "stage", id, stage: "awaiting-deploy", needs: row.needs });

			expect(staged.isError).toBeUndefined();
			expect(textOf(staged)).toBe(`#${id} ${row.text}`);
			const record = await findIssueById(tempDir, id);
			expect(record?.frontmatter.stage).toBe("awaiting-deploy");
			expect(record?.frontmatter.needs).toBe(row.needsAfter);
		});
	}

	it("add with stage awaiting-deploy records the `needs` text", async () => {
		const created = await runIssuesOp(tempDir, {
			op: "add",
			category: "infra",
			title: "Flaky deploy",
			body: "B.",
			stage: "awaiting-deploy",
			needs: "Roll api v2.3.1 to prod",
		});

		expect(created.isError).toBeUndefined();
		const record = await findIssueById(tempDir, (created.details as IssuesToolDetails).id!);
		expect(record?.frontmatter.stage).toBe("awaiting-deploy");
		expect(record?.frontmatter.needs).toBe("Roll api v2.3.1 to prod");
	});

	const stageRejections: Array<{
		name: string;
		params: { stage: "needs-you" | "running" | "none"; needs?: string };
		error: RegExp | string;
	}> = [
		{
			name: "needs-you without `needs`",
			params: { stage: "needs-you" },
			error: /`stage: needs-you` needs a `needs` text/,
		},
		{
			name: "needs-you with a blank `needs`",
			params: { stage: "needs-you", needs: " \n " },
			error: /non-empty string/,
		},
		{
			name: "`needs` with stage running",
			params: { stage: "running", needs: "Approve it?" },
			error: NEEDS_STAGE_ONLY,
		},
		{
			name: "`needs` with stage none",
			params: { stage: "none", needs: "Approve it?" },
			error: NEEDS_STAGE_ONLY,
		},
	];
	for (const row of stageRejections) {
		it(`stage rejects ${row.name} and leaves the file, claim, and pending replies untouched`, async () => {
			const created = await runIssuesOp(tempDir, {
				op: "add",
				category: "infra",
				title: "Flaky deploy",
				body: "B.",
			});
			const id = (created.details as IssuesToolDetails).id!;
			const reply = "Keep the existing deployment until the replacement is approved.";
			await replyToIssue(tempDir, id, reply);
			const filePath = (await findIssueById(tempDir, id))!.filePath;
			const before = await Bun.file(filePath).text();

			const result = await runIssuesOp(tempDir, { op: "stage", id, ...row.params }, { sessionId: "session-main" });

			expect(result.isError).toBe(true);
			expect((result.details as IssuesToolDetails).error).toMatch(row.error);
			expect(await Bun.file(filePath).text()).toBe(before);
			expect(await claimOwner(tempDir, id)).toBeUndefined();
			expect((await listReplies(tempDir)).map(pending => pending.text)).toEqual([reply]);
			expect(textOf(result)).not.toContain(reply);
		});
	}

	const addRejections: Array<{
		name: string;
		params: {
			stage?: "needs-you" | "up-next" | "running";
			needs?: string;
			status?: "fixed";
		};
		error: RegExp | string;
	}> = [
		{
			name: "needs-you without `needs`",
			params: { stage: "needs-you" },
			error: /`stage: needs-you` needs a `needs` text/,
		},
		{
			name: "needs-you with a blank `needs`",
			params: { stage: "needs-you", needs: "   " },
			error: /non-empty string/,
		},
		{
			name: "`needs` with stage up-next",
			params: { stage: "up-next", needs: "Approve it?" },
			error: NEEDS_STAGE_ONLY,
		},
		{
			name: "`needs` without a stage",
			params: { needs: "Approve it?" },
			error: NEEDS_STAGE_ONLY,
		},
		{
			name: "a stage on a terminal status",
			params: { stage: "running", status: "fixed" },
			error: /a 'fixed' issue is archived work and carries no stage/,
		},
	];
	for (const row of addRejections) {
		it(`add rejects ${row.name} without creating a file`, async () => {
			const result = await runIssuesOp(tempDir, {
				op: "add",
				category: "infra",
				title: "Flaky deploy",
				body: "B.",
				...row.params,
			});

			expect(result.isError).toBe(true);
			expect((result.details as IssuesToolDetails).error).toMatch(row.error);
			expect(await listIssues(tempDir)).toEqual([]);
		});
	}
});

describe("issues tool: running and needs-you claim the issue for the calling session", () => {
	const SELF = "4f1c2a9e";
	const PEER = "9d0e7b31";

	async function addRunnable(): Promise<number> {
		const created = await runIssuesOp(tempDir, { op: "add", category: "infra", title: "Flaky deploy", body: "B." });
		return (created.details as IssuesToolDetails).id!;
	}

	it("a stage call without a session id leaves replies pending for the main session that claims the issue", async () => {
		const id = await addRunnable();
		const reply = "Do not switch runners; retry the existing deployment.";
		await replyToIssue(tempDir, id, reply);

		const unclaimed = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" });
		expect(unclaimed.isError).toBeUndefined();
		expect(textOf(unclaimed)).not.toContain(reply);
		expect(await claimOwner(tempDir, id)).toBeUndefined();
		expect((await listReplies(tempDir)).map(pending => pending.text)).toEqual([reply]);
		expect((await findIssueById(tempDir, id))?.body).toBe("B.");

		const started = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: SELF });
		expect(textOf(started)).toContain(reply);
		expect(await claimOwner(tempDir, id)).toBe(SELF);
		expect(await listReplies(tempDir)).toEqual([]);
	});

	it("stage needs-you returns pending answers without changing the requested stage, and re-claiming cannot replay them", async () => {
		const id = await addRunnable();
		const reply = "Use the existing runner.\n\nDo not create a second deployment.";
		await replyToIssue(tempDir, id, reply);
		const params = { op: "stage", id, stage: "needs-you", needs: "Approve the retry?" } as const;

		const staged = await runIssuesOp(tempDir, params, { sessionId: SELF });
		expect(staged.isError).toBeUndefined();
		expect(textOf(staged)).toContain(reply);
		expect(await claimOwner(tempDir, id)).toBe(SELF);
		const after = (await findIssueById(tempDir, id))!;
		expect(after.frontmatter.stage).toBe("needs-you");
		expect(after.frontmatter.needs).toBe("Approve the retry?");
		expect(after.body.split(reply)).toHaveLength(2);
		expect(await listReplies(tempDir)).toEqual([]);

		const repeated = await runIssuesOp(tempDir, params, { sessionId: SELF });
		expect(textOf(repeated)).not.toContain(reply);
		expect((await findIssueById(tempDir, id))?.body).toBe(after.body);
	});

	it("a failed claim leaves replies pending even when the stage move succeeds", async () => {
		const id = await addRunnable();
		const reply = "Wait for approval before changing the runner.";
		await replyToIssue(tempDir, id, reply);
		// A file where the claims directory belongs makes claim storage unavailable.
		const claimsPath = path.join(inboxDir(tempDir), "claims");
		await fs.writeFile(claimsPath, "unavailable");

		const staged = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: SELF });
		expect(staged.isError).toBeUndefined();
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("running");
		expect(textOf(staged)).not.toContain(reply);
		expect((await listReplies(tempDir)).map(pending => pending.text)).toEqual([reply]);
		expect((await findIssueById(tempDir, id))?.body).toBe("B.");

		await fs.rm(claimsPath);
		const retried = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: SELF });
		expect(textOf(retried)).toContain(reply);
		expect(await claimOwner(tempDir, id)).toBe(SELF);
		expect(await listReplies(tempDir)).toEqual([]);
	});

	const filings: Array<{ stage: "running" | "needs-you" | "up-next"; needs?: string; claims: boolean }> = [
		{ stage: "running", claims: true },
		{ stage: "needs-you", needs: "Approve it?", claims: true },
		{ stage: "up-next", claims: false },
	];
	for (const row of filings) {
		it(`add with stage ${row.stage} files the issue in that stage, ${row.claims ? "claimed for a main session" : "unclaimed"}; a subagent call claims nothing`, async () => {
			const add = {
				op: "add",
				category: "infra",
				title: "Flaky deploy",
				body: "B.",
				stage: row.stage,
				needs: row.needs,
			} as const;

			const fromMain = await runIssuesOp(tempDir, add, { sessionId: SELF });
			const mainId = (fromMain.details as IssuesToolDetails).id!;
			expect(fromMain.isError).toBeUndefined();
			expect((await findIssueById(tempDir, mainId))?.frontmatter.stage).toBe(row.stage);
			expect(await claimOwner(tempDir, mainId)).toBe(row.claims ? SELF : undefined);
			if (row.claims) expect(textOf(fromMain)).toContain("claimed for this session");
			else expect(textOf(fromMain)).not.toContain("claimed");

			const fromSubagent = await runIssuesOp(tempDir, add);
			const subagentId = (fromSubagent.details as IssuesToolDetails).id!;
			expect((await findIssueById(tempDir, subagentId))?.frontmatter.stage).toBe(row.stage);
			expect(await claimOwner(tempDir, subagentId)).toBeUndefined();
			expect(textOf(fromSubagent)).not.toContain("claimed");
		});
	}

	it("a conflicting live holder keeps its replies until it claims through its own session", async () => {
		const id = await addRunnable();
		const reply = "Keep the deployment manual; do not enable automatic retries.";
		await replyToIssue(tempDir, id, reply);
		await touchPresence(tempDir, PEER);
		expect(await claim(tempDir, id, PEER)).toBe(true);

		const started = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: SELF });

		expect(started.isError).toBeUndefined();
		expect((await findIssueById(tempDir, id))?.frontmatter.stage).toBe("running");
		expect(textOf(started)).toContain(`#${id} is held by another live session (${PEER.slice(0, 6)})`);
		expect(await claimOwner(tempDir, id)).toBe(PEER);
		expect(textOf(started)).not.toContain(reply);
		expect((await listReplies(tempDir)).map(pending => pending.text)).toEqual([reply]);
		expect((await findIssueById(tempDir, id))?.body).toBe("B.");

		const held = await runIssuesOp(tempDir, { op: "stage", id, stage: "running" }, { sessionId: PEER });
		expect(textOf(held)).toContain(reply);
		expect(await claimOwner(tempDir, id)).toBe(PEER);
		expect(await listReplies(tempDir)).toEqual([]);
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
