import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import { claim, listQueued, listReplies, PRESENCE_STALE_MS, setQueued, takeReply, touchPresence } from "../src/inbox";
import {
	addIssue,
	appendReplyHistory,
	archiveIssue,
	findIssueByFilename,
	findIssueById,
	getIssuesRoot,
	type IssueStage,
	type IssueStatus,
	listIssueRecords,
	listIssues,
	listQueuedIssues,
	moveIssue,
	NEEDS_STAGE_ONLY,
	normalizeCategory,
	replyToIssue,
	saveIssueContent,
	slugifyTitle,
	unarchiveIssue,
} from "../src/store";
import { useTempAgentDir } from "./agent-dir";

useTempAgentDir();

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-store-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

// The metadata-edit surface is the `issues://<id>.md` file write
// (`saveIssueContent`). `editVia` mirrors what the `edit` tool does: read the
// file, mutate the parsed frontmatter, and write the whole thing back through
// the store's validating path.
async function editVia(cwd: string, id: number, mutate: (frontmatter: Record<string, unknown>) => void) {
	const record = await findIssueById(cwd, id);
	if (!record) throw new Error(`Issue #${id} not found`);
	const text = await Bun.file(record.filePath).text();
	const { frontmatter, body } = parseFrontmatter(text, { normalize: false });
	mutate(frontmatter);
	const lines = Object.entries(frontmatter)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
	return saveIssueContent(cwd, id, `---\n${lines.join("\n")}\n---\n\n${body}\n`);
}

describe("issues store: slug + category normalization", () => {
	it("slugifies titles into ≤5-word lowercase kebab", () => {
		expect(slugifyTitle("Replace allow-all network egress with default-deny isolation")).toBe(
			"replace-allow-all-network-egress",
		);
		expect(slugifyTitle("Fix: NULL pointer in alpha()")).toBe("fix-null-pointer-in-alpha");
		expect(slugifyTitle("    ")).toBe("untitled");
		expect(slugifyTitle("a")).toBe("a");
	});

	it("normalizes categories and rejects escape/empty names", () => {
		expect(normalizeCategory("Security Stuff")).toBe("security-stuff");
		expect(normalizeCategory("Data Correctness!!")).toBe("data-correctness");
		expect(normalizeCategory("archive")).toBe("archive"); // no longer reserved — `.archive` is the (hidden) archive bucket
		expect(() => normalizeCategory("../leak")).toThrow(/Invalid issue category/);
		expect(() => normalizeCategory("a/b")).toThrow(/Invalid issue category/);
		expect(() => normalizeCategory("!!!")).toThrow(/Invalid issue category/);
		expect(() => normalizeCategory("")).toThrow(/Invalid issue category/);
	});
});

describe("issues store: lifecycle", () => {
	it("allocates global ids across categories", async () => {
		const first = await addIssue(tempDir, {
			category: "security",
			title: "First finding",
			body: "Body of the first finding.",
		});
		const second = await addIssue(tempDir, {
			category: "correctness",
			title: "Second finding",
			body: "Body of the second finding.",
		});
		const third = await addIssue(tempDir, {
			category: "security",
			title: "Third finding",
			body: "Body of the third finding.",
		});

		expect(first.record.id).toBe(1);
		expect(second.record.id).toBe(2);
		expect(third.record.id).toBe(3);
		expect(first.record.filename).toBe("1-first-finding.md");
		expect(second.record.filename).toBe("2-second-finding.md");
		expect(third.record.filename).toBe("3-third-finding.md");

		const onDisk = await fs.readFile(path.join(getIssuesRoot(tempDir), "security", "1-first-finding.md"), "utf-8");
		const { frontmatter } = parseFrontmatter(onDisk, { source: "test" });
		expect(frontmatter.title).toBe("First finding");
		expect(frontmatter.category).toBe("security");
		expect(frontmatter.status).toBe("open");
		expect(typeof frontmatter.created).toBe("string");
	});

	it("recovers id allocation after the counter file is deleted", async () => {
		await addIssue(tempDir, { category: "security", title: "First", body: "Body A." });
		await addIssue(tempDir, { category: "security", title: "Second", body: "Body B." });
		// Simulate a stale checkout that lost the counter.
		await fs.rm(path.join(getIssuesRoot(tempDir), ".next-id"), { force: true });

		const next = await addIssue(tempDir, {
			category: "security",
			title: "Third",
			body: "Body C.",
		});
		expect(next.record.id).toBe(3);
	});

	it("finds issues by id and by filename (id-only or full)", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Fix auth egress",
			body: "Detail.",
		});
		const byId = await findIssueById(tempDir, record.id);
		const byFullName = await findIssueByFilename(tempDir, record.filename);
		const byIdName = await findIssueByFilename(tempDir, `${record.id}.md`);
		const byBareId = await findIssueByFilename(tempDir, String(record.id));
		const missing = await findIssueByFilename(tempDir, "999.md");
		expect(byId?.id).toBe(record.id);
		expect(byFullName?.id).toBe(record.id);
		expect(byIdName?.id).toBe(record.id);
		expect(byBareId?.id).toBe(record.id);
		expect(missing).toBeUndefined();
	});

	it("edit renames file when title changes and moves it when category changes", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Old title",
			body: "Original body.",
		});
		const oldPath = record.filePath;

		const renamed = await editVia(tempDir, record.id, fm => {
			fm.title = "New shorter title";
		});
		expect(renamed.renamed).toBe(true);
		expect(renamed.transitioned).toBe(false);
		expect(renamed.wasArchived).toBe(false);
		expect(renamed.record.filename).toBe(`${record.id}-new-shorter-title.md`);
		expect(await Bun.file(oldPath).exists()).toBe(false);
		// Body is preserved when the edit only touches metadata.
		expect(renamed.record.body).toBe("Original body.");

		const moved = await editVia(tempDir, record.id, fm => {
			fm.category = "correctness";
		});
		expect(moved.moved).toBe(true);
		expect(moved.transitioned).toBe(false);
		expect(moved.record.category).toBe("correctness");
		expect(moved.record.filePath).toContain(`${path.sep}correctness${path.sep}`);
	});

	it("archive moves to .archive/<cat> and unarchive restores it", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Privilege leak",
			body: "Body.",
		});
		const activePath = record.filePath;

		const archived = await archiveIssue(tempDir, record.id, { reason: "Fixed in #321" });
		expect(archived.wasArchived).toBe(false);
		expect(archived.record.archived).toBe(true);
		expect(archived.record.filePath).toContain(`${path.sep}.archive${path.sep}security${path.sep}`);
		expect(archived.record.frontmatter.status).toBe("fixed");
		expect(archived.record.frontmatter.archive_reason).toBe("Fixed in #321");
		expect(await Bun.file(activePath).exists()).toBe(false);

		const restored = await unarchiveIssue(tempDir, record.id);
		expect(restored.wasActive).toBe(false);
		expect(restored.record.archived).toBe(false);
		expect(restored.record.frontmatter.status).toBe("open");
		expect(restored.record.frontmatter.archive_reason).toBeUndefined();
	});

	it("archive of an already-archived issue is a no-op", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "X",
			body: "B.",
		});
		await archiveIssue(tempDir, record.id);
		const second = await archiveIssue(tempDir, record.id);
		expect(second.wasArchived).toBe(true);
		expect(second.record.archived).toBe(true);
	});

	it("editing status to a terminal value auto-archives, and reopening restores + drops archive_reason", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Privilege leak",
			body: "Body.",
		});
		const activePath = record.filePath;

		// `fixed` is a terminal status → auto-archive; stamp a reason to prove reopen drops it.
		const archived = await editVia(tempDir, record.id, fm => {
			fm.status = "fixed";
			fm.archive_reason = "handled in #99";
		});
		expect(archived.transitioned).toBe(true);
		expect(archived.wasArchived).toBe(false);
		expect(archived.record.archived).toBe(true);
		expect(archived.record.frontmatter.status).toBe("fixed");
		expect(archived.record.frontmatter.archive_reason).toBe("handled in #99");
		expect(archived.record.filePath).toContain(`${path.sep}.archive${path.sep}security${path.sep}`);
		expect(await Bun.file(activePath).exists()).toBe(false);

		// Editing an archived issue is now allowed; metadata-only edits stay archived.
		const metadataOnly = await editVia(tempDir, record.id, fm => {
			fm.severity = "low";
		});
		expect(metadataOnly.transitioned).toBe(false);
		expect(metadataOnly.record.archived).toBe(true);
		expect(metadataOnly.record.frontmatter.severity).toBe("low");

		// `open` is a non-terminal status → auto-restore + drop archive_reason.
		const restored = await editVia(tempDir, record.id, fm => {
			fm.status = "open";
		});
		expect(restored.transitioned).toBe(true);
		expect(restored.wasArchived).toBe(true);
		expect(restored.record.archived).toBe(false);
		expect(restored.record.frontmatter.status).toBe("open");
		expect(restored.record.frontmatter.archive_reason).toBeUndefined();
	});

	it("editing a same-side status is an in-place edit (no archive transition)", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "WIP item",
			body: "Body.",
		});
		// open → in-progress is still on the active side; no transition.
		const same = await editVia(tempDir, record.id, fm => {
			fm.status = "in-progress";
		});
		expect(same.transitioned).toBe(false);
		expect(same.record.archived).toBe(false);
		expect(same.record.frontmatter.status).toBe("in-progress");
	});

	it("archives on any non-active status (wontfix, duplicate), not just fixed", async () => {
		for (const status of ["wontfix", "duplicate"] as const) {
			const { record } = await addIssue(tempDir, { category: "security", title: `Close ${status}`, body: "B." });
			const res = await editVia(tempDir, record.id, fm => {
				fm.status = status;
			});
			expect(res.transitioned).toBe(true);
			expect(res.record.archived).toBe(true);
			expect(res.record.frontmatter.status).toBe(status);
			expect(res.record.filePath).toContain(`${path.sep}.archive${path.sep}`);
		}
	});
});

describe("issues store: listing + filtering", () => {
	it("lists active and archived issues with severity/status/query filters", async () => {
		const a = await addIssue(tempDir, {
			category: "security",
			title: "Sql injection in handler",
			body: "Allows attacker to read user table.",
			severity: "critical",
		});
		const b = await addIssue(tempDir, {
			category: "correctness",
			title: "Off-by-one in loop",
			body: "Last element missed when calling chunked iterator.",
			severity: "medium",
		});
		const c = await addIssue(tempDir, {
			category: "security",
			title: "Stack overflow risk",
			body: "Recursive parser may exhaust stack.",
			severity: "high",
		});
		await archiveIssue(tempDir, b.record.id, { reason: "Fixed" });

		const active = await listIssues(tempDir, { archived: false });
		expect(active.map(s => s.id).sort((x, y) => x - y)).toEqual([a.record.id, c.record.id]);

		const archived = await listIssues(tempDir, { archived: true });
		expect(archived.map(s => s.id)).toEqual([b.record.id]);

		const both = await listIssues(tempDir);
		expect(both.map(s => s.id).sort((x, y) => x - y)).toEqual([a.record.id, b.record.id, c.record.id]);

		const bySeverity = await listIssues(tempDir, { severity: "critical" });
		expect(bySeverity.map(s => s.id)).toEqual([a.record.id]);

		const byCategory = await listIssues(tempDir, { category: "security", archived: false });
		expect(byCategory.map(s => s.id).sort((x, y) => x - y)).toEqual([a.record.id, c.record.id]);

		const byQuery = await listIssues(tempDir, { query: "recursive parser" });
		expect(byQuery.map(s => s.id)).toEqual([c.record.id]);

		const limited = await listIssues(tempDir, { limit: 1 });
		expect(limited.length).toBe(1);
		// Newest id first.
		expect(limited[0].id).toBe(c.record.id);
	});
});

describe("issues store: empty category directory pruning", () => {
	async function dirExists(dir: string): Promise<boolean> {
		try {
			const stat = await fs.stat(dir);
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	it("removes the active category dir when its last issue is archived, keeping siblings", async () => {
		const root = getIssuesRoot(tempDir);
		const security = await addIssue(tempDir, { category: "security", title: "Lone", body: "B." });
		const correctnessA = await addIssue(tempDir, { category: "correctness", title: "Keep A", body: "B." });
		await addIssue(tempDir, { category: "correctness", title: "Keep B", body: "B." });

		await archiveIssue(tempDir, security.record.id);
		// security had a single issue → its active dir is gone.
		expect(await dirExists(path.join(root, "security"))).toBe(false);
		// correctness still holds an issue → untouched.
		expect(await dirExists(path.join(root, "correctness"))).toBe(true);

		// Archiving one of two issues in a category must NOT prune it.
		await archiveIssue(tempDir, correctnessA.record.id);
		expect(await dirExists(path.join(root, "correctness"))).toBe(true);
		// The issues root itself is never pruned (anchors the counter + archive).
		expect(await dirExists(root)).toBe(true);
	});

	it("removes the source category dir on a cross-category move", async () => {
		const root = getIssuesRoot(tempDir);
		const { record } = await addIssue(tempDir, { category: "security", title: "Movable", body: "B." });
		expect(await dirExists(path.join(root, "security"))).toBe(true);

		await editVia(tempDir, record.id, fm => {
			fm.category = "correctness";
		});
		expect(await dirExists(path.join(root, "security"))).toBe(false);
		expect(await dirExists(path.join(root, "correctness"))).toBe(true);
	});

	it("keeps the category dir on a same-category slug rename", async () => {
		const root = getIssuesRoot(tempDir);
		const { record } = await addIssue(tempDir, { category: "security", title: "Old name", body: "B." });

		await editVia(tempDir, record.id, fm => {
			fm.title = "New name entirely";
		});
		// The renamed file still lives in security/ → dir must survive (the new
		// file landed before the old one was removed, so rmdir hits ENOTEMPTY).
		expect(await dirExists(path.join(root, "security"))).toBe(true);
	});

	it("removes the archived category dir and the archive root when the last archived issue is unarchived", async () => {
		const archiveRoot = path.join(getIssuesRoot(tempDir), ".archive");
		const { record } = await addIssue(tempDir, { category: "security", title: "Round trip", body: "B." });
		await archiveIssue(tempDir, record.id);
		expect(await dirExists(path.join(archiveRoot, "security"))).toBe(true);

		await unarchiveIssue(tempDir, record.id);
		// Archived category emptied → pruned; archive root now empty → also pruned.
		expect(await dirExists(path.join(archiveRoot, "security"))).toBe(false);
		expect(await dirExists(archiveRoot)).toBe(false);
	});

	it("keeps the archive root when another archived category remains", async () => {
		const archiveRoot = path.join(getIssuesRoot(tempDir), ".archive");
		const a = await addIssue(tempDir, { category: "security", title: "A", body: "B." });
		const b = await addIssue(tempDir, { category: "correctness", title: "B", body: "B." });
		await archiveIssue(tempDir, a.record.id);
		await archiveIssue(tempDir, b.record.id);

		await unarchiveIssue(tempDir, a.record.id);
		// security archive dir emptied → pruned, but correctness archive remains,
		// so the archive root must survive.
		expect(await dirExists(path.join(archiveRoot, "security"))).toBe(false);
		expect(await dirExists(path.join(archiveRoot, "correctness"))).toBe(true);
		expect(await dirExists(archiveRoot)).toBe(true);
	});
});

describe("issues store: concurrent add safety", () => {
	it("hands out unique ids for many concurrent adds in one process", async () => {
		const count = 12;
		// Distinct titles → distinct slugs → distinct filenames, so a plain `wx`
		// exclusive create cannot catch a same-id collision; only serialized
		// allocation can. This is the exact shape that previously double-allocated.
		const results = await Promise.all(
			Array.from({ length: count }, (_, i) =>
				addIssue(tempDir, { category: "security", title: `Concurrent finding ${i}`, body: "B." }),
			),
		);
		const ids = results.map(r => r.record.id);
		expect(new Set(ids).size).toBe(count);
		// Every allocated id resolves back to its own record (files actually landed).
		for (const r of results) {
			expect((await findIssueById(tempDir, r.record.id))?.id).toBe(r.record.id);
		}
		const all = await listIssues(tempDir, { archived: false });
		expect(all.length).toBe(count);
	});
});

// Frontmatter exactly as written to disk, parsed independently of the store's
// in-memory record so a move that returns one thing and writes another is caught.
async function readFrontmatterOnDisk(filePath: string): Promise<Record<string, unknown>> {
	const text = await Bun.file(filePath).text();
	return parseFrontmatter(text, { source: filePath, normalize: false }).frontmatter;
}

describe("issues store: listIssueRecords", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns active and archived records with full frontmatter and bodies", async () => {
		const active = await addIssue(tempDir, {
			category: "security",
			title: "Token in logs",
			body: "Active body.",
			extra: { stage: "running", owner: "alice" },
		});
		const archived = await addIssue(tempDir, {
			category: "correctness",
			title: "Off by one",
			body: "Archived body.",
		});
		await archiveIssue(tempDir, archived.record.id, { reason: "fixed upstream" });

		const records = await listIssueRecords(tempDir);
		expect(records.map(r => r.id).sort((a, b) => a - b)).toEqual([active.record.id, archived.record.id]);

		const byId = new Map(records.map(r => [r.id, r]));
		const a = byId.get(active.record.id)!;
		expect(a.archived).toBe(false);
		expect(a.category).toBe("security");
		expect(a.body).toBe("Active body.");
		expect(a.frontmatter.stage).toBe("running");
		expect(a.frontmatter.owner).toBe("alice");

		const b = byId.get(archived.record.id)!;
		expect(b.archived).toBe(true);
		expect(b.category).toBe("correctness");
		expect(b.body).toBe("Archived body.");
		expect(b.frontmatter.archive_reason).toBe("fixed upstream");
	});

	it("skips a file that vanishes between the scan and the read", async () => {
		const kept = await addIssue(tempDir, { category: "security", title: "Kept", body: "B." });
		const gone = await addIssue(tempDir, { category: "security", title: "Gone", body: "B." });
		const victim = gone.record.filePath;

		// The scan has already listed the file; delete it at the moment it is
		// opened, exactly as a concurrent archive/unarchive would.
		const realFile = Bun.file as (path: string, options?: BlobPropertyBag) => BunFile;
		vi.spyOn(Bun, "file").mockImplementation(((filePath: string, options?: BlobPropertyBag) => {
			if (filePath === victim) fsSync.rmSync(victim, { force: true });
			return realFile(filePath, options);
		}) as typeof Bun.file);

		const records = await listIssueRecords(tempDir);
		expect(records.map(r => r.id)).toEqual([kept.record.id]);
	});
});

describe("issues store: moveIssue", () => {
	afterEach(() => {
		setSystemTime();
	});

	it("sets, changes, and clears stage in place on an active issue", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });

		const running = await moveIssue(tempDir, record.id, { stage: "running" });
		expect(running.filePath).toBe(record.filePath);
		expect(running.archived).toBe(false);
		expect((await readFrontmatterOnDisk(record.filePath)).stage).toBe("running");

		await moveIssue(tempDir, record.id, { stage: "needs-you" });
		expect((await readFrontmatterOnDisk(record.filePath)).stage).toBe("needs-you");

		const cleared = await moveIssue(tempDir, record.id, { stage: null });
		const onDisk = await readFrontmatterOnDisk(record.filePath);
		// Deleted, not written as `stage: null`.
		expect("stage" in onDisk).toBe(false);
		expect(onDisk.status).toBe("open");
		expect(cleared.archived).toBe(false);
	});

	for (const status of ["fixed", "wontfix", "duplicate"] as const) {
		it(`status ${status} archives into .archive/<category>/, drops stage, records the reason`, async () => {
			const root = getIssuesRoot(tempDir);
			const { record } = await addIssue(tempDir, {
				category: "infra",
				title: "Flaky deploy",
				body: "B.",
				extra: { stage: "awaiting-deploy" },
			});

			// A stage in the same move must not leak onto the archived file.
			const moved = await moveIssue(tempDir, record.id, { stage: "running", status, reason: "closed by board" });

			const archivedPath = path.join(root, ".archive", "infra", record.filename);
			expect(moved.archived).toBe(true);
			expect(moved.filePath).toBe(archivedPath);
			expect(fsSync.existsSync(record.filePath)).toBe(false);
			// The emptied active category directory is pruned.
			expect(fsSync.existsSync(path.join(root, "infra"))).toBe(false);

			const onDisk = await readFrontmatterOnDisk(archivedPath);
			expect(onDisk.status).toBe(status);
			expect(onDisk.archive_reason).toBe("closed by board");
			expect("stage" in onDisk).toBe(false);
		});
	}

	it("an active status on an archived issue unarchives it, sets the stage, and drops archive_reason", async () => {
		const root = getIssuesRoot(tempDir);
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		await moveIssue(tempDir, record.id, { stage: null, status: "fixed", reason: "looked fixed" });

		const reopened = await moveIssue(tempDir, record.id, { stage: "running", status: "in-progress" });

		expect(reopened.archived).toBe(false);
		expect(reopened.filePath).toBe(record.filePath);
		// The archive copy is retired and its emptied category + root pruned.
		expect(fsSync.existsSync(path.join(root, ".archive"))).toBe(false);

		const onDisk = await readFrontmatterOnDisk(record.filePath);
		expect(onDisk.status).toBe("in-progress");
		expect(onDisk.stage).toBe("running");
		expect("archive_reason" in onDisk).toBe(false);
	});

	it("a stage-only move on an archived issue keeps it archived with no stage and its reason", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		const archived = await moveIssue(tempDir, record.id, { stage: null, status: "wontfix", reason: "by design" });

		const moved = await moveIssue(tempDir, record.id, { stage: "running" });

		expect(moved.archived).toBe(true);
		expect(moved.filePath).toBe(archived.filePath);
		const onDisk = await readFrontmatterOnDisk(archived.filePath);
		expect("stage" in onDisk).toBe(false);
		expect(onDisk.status).toBe("wontfix");
		expect(onDisk.archive_reason).toBe("by design");
	});

	it("preserves every other frontmatter key and the body across moves, bumping only updated", async () => {
		const created = new Date("2026-01-01T00:00:00.000Z");
		const firstMove = new Date("2026-02-01T00:00:00.000Z");
		const secondMove = new Date("2026-03-01T00:00:00.000Z");
		const body = [
			"## Repro",
			"",
			"- step: one",
			"- step two",
			"",
			"```ts",
			"const x = { a: 1 };",
			"```",
			"",
			"---",
			"",
			"Trailing paragraph after a horizontal rule.",
		].join("\n");

		setSystemTime(created);
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Flaky deploy",
			body,
			severity: "high",
			location: ["src/deploy.ts:42"],
			extra: {
				owner: "alice",
				priority: 2,
				blocked: false,
				links: ["pr://12", "issue://3"],
				meta: { reviewer: "ana", round: 2 },
			},
		});
		expect(record.body).toBe(body);

		setSystemTime(firstMove);
		await moveIssue(tempDir, record.id, { stage: "running" });
		const afterStage = (await findIssueById(tempDir, record.id))!;
		expect(afterStage.frontmatter).toEqual({
			...record.frontmatter,
			stage: "running",
			updated: firstMove.toISOString(),
		});
		expect(afterStage.body).toBe(body);

		setSystemTime(secondMove);
		await moveIssue(tempDir, record.id, { stage: null, status: "fixed", reason: "shipped" });
		const afterArchive = (await findIssueById(tempDir, record.id))!;
		expect(afterArchive.archived).toBe(true);
		expect(afterArchive.frontmatter).toEqual({
			...record.frontmatter,
			status: "fixed",
			archive_reason: "shipped",
			updated: secondMove.toISOString(),
		});
		expect(afterArchive.frontmatter.created).toBe(created.toISOString());
		expect(afterArchive.body).toBe(body);
	});

	it("re-reads from disk, keeping an edit (including a rename) made after the caller's listing", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "Original body." });
		const [listed] = await listIssueRecords(tempDir);
		expect(listed.id).toBe(record.id);

		// Another writer edits the issue after the board listed it: new body, new
		// key, new severity, and a title change that renames the file.
		await saveIssueContent(
			tempDir,
			record.id,
			[
				"---",
				"title: Flaky deploy on arm",
				"category: infra",
				"severity: critical",
				"owner: agent-7",
				"---",
				"",
				"Body rewritten by another agent.",
			].join("\n"),
		);

		const moved = await moveIssue(tempDir, listed.id, { stage: "needs-you" });

		// Exactly one file for the id: the stale filename is not resurrected.
		const all = await listIssueRecords(tempDir);
		expect(all.filter(r => r.id === record.id)).toHaveLength(1);
		expect(fsSync.existsSync(listed.filePath)).toBe(false);
		expect(moved.filename).toBe(`${record.id}-flaky-deploy-on-arm.md`);

		const onDisk = await readFrontmatterOnDisk(moved.filePath);
		expect(onDisk.stage).toBe("needs-you");
		expect(onDisk.severity).toBe("critical");
		expect(onDisk.owner).toBe("agent-7");
		expect(onDisk.title).toBe("Flaky deploy on arm");
		expect(moved.body).toBe("Body rewritten by another agent.");
	});

	it("rejects an unknown id or an out-of-enum stage/status without touching disk", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		const before = await Bun.file(record.filePath).text();

		await expect(moveIssue(tempDir, 999, { stage: "running" })).rejects.toThrow("Issue #999 not found.");
		await expect(moveIssue(tempDir, record.id, { stage: "blocked" as IssueStage })).rejects.toThrow(/invalid stage/);
		await expect(moveIssue(tempDir, record.id, { stage: null, status: "closed" as IssueStatus })).rejects.toThrow(
			/invalid status/,
		);

		expect(await Bun.file(record.filePath).text()).toBe(before);
		expect((await listIssueRecords(tempDir)).map(r => r.id)).toEqual([record.id]);
	});
});

describe("issues store: stage validation on add", () => {
	it("rejects an out-of-enum stage in extra before creating a file, and accepts a valid one", async () => {
		for (const stage of ["blocked", "Running", 3]) {
			await expect(
				addIssue(tempDir, { category: "infra", title: "Bad stage", body: "B.", extra: { stage } }),
			).rejects.toThrow(/invalid stage/);
		}
		expect(await listIssueRecords(tempDir)).toEqual([]);

		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Good stage",
			body: "B.",
			extra: { stage: "deferred" },
		});
		expect((await readFrontmatterOnDisk(record.filePath)).stage).toBe("deferred");
	});
});

describe("issues store: `needs` rides only with an active needs-you or awaiting-deploy issue", () => {
	const NEEDS = "One table per tenant, or a shared table?";
	const ROLL = "Roll api v2.3.1 to prod";

	async function waitingIssue(stage: "needs-you" | "awaiting-deploy" = "needs-you"): Promise<number> {
		const needs = stage === "needs-you" ? NEEDS : ROLL;
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Pick the storage layout",
			body: "B.",
			stage,
			needs,
		});
		expect((await readFrontmatterOnDisk(record.filePath)).needs).toBe(needs);
		return record.id;
	}

	async function needsOnDisk(id: number): Promise<unknown> {
		const onDisk = await readFrontmatterOnDisk((await findIssueById(tempDir, id))!.filePath);
		return "needs" in onDisk ? onDisk.needs : undefined;
	}

	const departures: Array<{
		name: string;
		from?: "needs-you" | "awaiting-deploy";
		leave: (id: number) => Promise<unknown>;
	}> = [
		{ name: "a stage move", leave: id => moveIssue(tempDir, id, { stage: "up-next" }) },
		{ name: "archiveIssue", leave: id => archiveIssue(tempDir, id, { reason: "answered elsewhere" }) },
		// The stage asked for is needs-you, but the terminal status archives it.
		{
			name: "a needs-you move onto a terminal status",
			leave: id => moveIssue(tempDir, id, { stage: "needs-you", status: "fixed" }),
		},
		{ name: "a board reply", leave: id => replyToIssue(tempDir, id, "Use a shared table.") },
		// The rewrite leaves the `needs` line in the file; only the stage changes.
		{
			name: "an issues:// rewrite that changes the stage",
			leave: id =>
				editVia(tempDir, id, frontmatter => {
					frontmatter.stage = "running";
				}),
		},
		// awaiting-deploy also takes text, but the question does not follow the issue there.
		{
			name: "a move to awaiting-deploy without text",
			leave: id => moveIssue(tempDir, id, { stage: "awaiting-deploy" }),
		},
		{
			name: "an issues:// rewrite to awaiting-deploy that removes the line",
			leave: id =>
				editVia(tempDir, id, frontmatter => {
					frontmatter.stage = "awaiting-deploy";
					delete frontmatter.needs;
				}),
		},
		// The question line is left in place; it must not become the deploy text.
		{
			name: "an issues:// rewrite to awaiting-deploy that leaves the line",
			leave: id =>
				editVia(tempDir, id, frontmatter => {
					frontmatter.stage = "awaiting-deploy";
				}),
		},
		{
			name: "a move to running",
			from: "awaiting-deploy",
			leave: id => moveIssue(tempDir, id, { stage: "running" }),
		},
		{
			name: "archiveIssue",
			from: "awaiting-deploy",
			leave: id => archiveIssue(tempDir, id, { reason: "rolled" }),
		},
	];
	for (const row of departures) {
		const from = row.from ?? "needs-you";
		it(`drops \`needs\` when the issue leaves ${from} through ${row.name}`, async () => {
			const id = await waitingIssue(from);

			await row.leave(id);

			expect(await needsOnDisk(id)).toBeUndefined();
		});
	}

	it("awaiting-deploy accepts a `needs` text through moveIssue, and an issues:// rewrite", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });

		const moved = await moveIssue(tempDir, record.id, { stage: "awaiting-deploy", needs: ROLL });
		expect(moved.frontmatter.stage).toBe("awaiting-deploy");
		expect(await needsOnDisk(record.id)).toBe(ROLL);

		await editVia(tempDir, record.id, frontmatter => {
			frontmatter.needs = "Roll api v2.3.2 to prod";
		});
		expect(await needsOnDisk(record.id)).toBe("Roll api v2.3.2 to prod");
	});

	const textlessDeploys: Array<{ name: string; enter: () => Promise<number> }> = [
		{
			name: "addIssue",
			enter: async () =>
				(
					await addIssue(tempDir, {
						category: "infra",
						title: "Flaky deploy",
						body: "B.",
						stage: "awaiting-deploy",
					})
				).record.id,
		},
		{
			name: "moveIssue",
			enter: async () => {
				const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
				await moveIssue(tempDir, record.id, { stage: "awaiting-deploy" });
				return record.id;
			},
		},
		{
			name: "an issues:// rewrite",
			enter: async () => {
				const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
				await editVia(tempDir, record.id, frontmatter => {
					frontmatter.stage = "awaiting-deploy";
				});
				return record.id;
			},
		},
	];
	for (const row of textlessDeploys) {
		it(`awaiting-deploy without text is accepted through ${row.name} and carries no \`needs\``, async () => {
			const id = await row.enter();

			expect((await findIssueById(tempDir, id))!.frontmatter.stage).toBe("awaiting-deploy");
			expect(await needsOnDisk(id)).toBeUndefined();
		});
	}

	it("keeps the awaiting-deploy text across a same-stage move and a rewrite that drops the line", async () => {
		const id = await waitingIssue("awaiting-deploy");

		await moveIssue(tempDir, id, { stage: "awaiting-deploy" });
		expect(await needsOnDisk(id)).toBe(ROLL);

		await editVia(tempDir, id, frontmatter => {
			delete frontmatter.needs;
		});
		expect(await needsOnDisk(id)).toBe(ROLL);
	});

	it("keeps `needs` while the issue stays needs-you: a move without text, an unrelated issues:// rewrite", async () => {
		const id = await waitingIssue();

		// The board's needs-you column move carries the stage only.
		await moveIssue(tempDir, id, { stage: "needs-you" });
		expect(await needsOnDisk(id)).toBe(NEEDS);

		await editVia(tempDir, id, frontmatter => {
			frontmatter.severity = "high";
		});
		expect(await needsOnDisk(id)).toBe(NEEDS);

		await moveIssue(tempDir, id, { stage: "needs-you", needs: "Shared table, partitioned how?" });
		expect(await needsOnDisk(id)).toBe("Shared table, partitioned how?");
	});

	it("archiveIssue drops the stage with the text, so unarchiving does not bring back a text-less needs-you", async () => {
		const id = await waitingIssue();

		const { record: archived } = await archiveIssue(tempDir, id, { reason: "answered elsewhere" });
		const archivedOnDisk = await readFrontmatterOnDisk(archived.filePath);
		expect("stage" in archivedOnDisk).toBe(false);
		expect("needs" in archivedOnDisk).toBe(false);

		const { record: restored } = await unarchiveIssue(tempDir, id);
		expect(restored.archived).toBe(false);
		const restoredOnDisk = await readFrontmatterOnDisk(restored.filePath);
		expect("stage" in restoredOnDisk).toBe(false);
		expect("needs" in restoredOnDisk).toBe(false);
	});

	it("the board can move an issue into needs-you without any text", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });

		const moved = await moveIssue(tempDir, record.id, { stage: "needs-you" });

		expect(moved.frontmatter.stage).toBe("needs-you");
		expect(await needsOnDisk(record.id)).toBeUndefined();
	});

	const entries: Array<{
		name: string;
		extra?: Record<string, unknown>;
		stage?: "awaiting-deploy";
		needs?: string;
	}> = [
		{ name: "a plain open issue" },
		{ name: "another stage", extra: { stage: "running" } },
		// The deploy text left in place is a leftover, not a question; the new text replaces it.
		{ name: "an awaiting-deploy issue with its text left in place", stage: "awaiting-deploy", needs: ROLL },
	];
	for (const row of entries) {
		it(`an issues:// rewrite of ${row.name} into needs-you must carry a \`needs\` text`, async () => {
			const { record } = await addIssue(tempDir, {
				category: "infra",
				title: "Flaky deploy",
				body: "B.",
				extra: row.extra,
				stage: row.stage,
				needs: row.needs,
			});
			const before = await Bun.file(record.filePath).text();

			await expect(
				editVia(tempDir, record.id, frontmatter => {
					frontmatter.stage = "needs-you";
				}),
			).rejects.toThrow("issues:// write rejected: `stage: needs-you` needs a `needs` text");
			expect(await Bun.file(record.filePath).text()).toBe(before);

			await editVia(tempDir, record.id, frontmatter => {
				frontmatter.stage = "needs-you";
				frontmatter.needs = NEEDS;
			});
			expect((await findIssueById(tempDir, record.id))!.frontmatter.stage).toBe("needs-you");
			expect(await needsOnDisk(record.id)).toBe(NEEDS);
		});
	}

	it("an issues:// rewrite that drops the `needs` line of a needs-you issue keeps the text", async () => {
		const id = await waitingIssue();

		await editVia(tempDir, id, frontmatter => {
			delete frontmatter.needs;
		});

		expect(await needsOnDisk(id)).toBe(NEEDS);
	});

	it("a board-marked text-less needs-you issue still accepts an unrelated issues:// rewrite", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		await moveIssue(tempDir, record.id, { stage: "needs-you" });

		await editVia(tempDir, record.id, frontmatter => {
			frontmatter.severity = "high";
		});

		const after = (await findIssueById(tempDir, record.id))!;
		expect(after.frontmatter.stage).toBe("needs-you");
		expect(after.frontmatter.severity).toBe("high");
		expect(await needsOnDisk(record.id)).toBeUndefined();
	});

	it("rejects a misplaced or blank `needs` on every write path without touching disk", async () => {
		const id = await waitingIssue();
		const filePath = (await findIssueById(tempDir, id))!.filePath;
		const before = await Bun.file(filePath).text();

		await expect(moveIssue(tempDir, id, { stage: "running", needs: "Approve it?" })).rejects.toThrow(
			`Issue move rejected: ${NEEDS_STAGE_ONLY}`,
		);
		await expect(moveIssue(tempDir, id, { stage: "needs-you", needs: "  " })).rejects.toThrow(/non-empty string/);
		await expect(
			editVia(tempDir, id, frontmatter => {
				frontmatter.needs = "";
			}),
		).rejects.toThrow(/issues:\/\/ write rejected: `needs` must be a non-empty string/);
		expect(await Bun.file(filePath).text()).toBe(before);

		await expect(
			addIssue(tempDir, {
				category: "infra",
				title: "Misplaced",
				body: "B.",
				stage: "up-next",
				needs: "Approve it?",
			}),
		).rejects.toThrow(`Issue rejected: ${NEEDS_STAGE_ONLY}`);
		await expect(
			addIssue(tempDir, { category: "infra", title: "Blank", body: "B.", stage: "needs-you", needs: "\n" }),
		).rejects.toThrow(/non-empty string/);
		expect((await listIssueRecords(tempDir)).map(r => r.id)).toEqual([id]);
	});
});

// A multi-line value exercising everything a YAML scalar can mangle: blank
// lines, both quote styles, `key: value` and `# comment` lookalikes, a list
// marker, a frontmatter fence, a backslash, a tab, and non-ASCII.
const TRICKY_TEXT = [
	`Line one: "double" and 'single' quotes`,
	"",
	"- not a list item",
	"---",
	"  indented: # not a comment",
	"key: value",
	"back\\slash, tab\there, ünïcode — dash",
].join("\n");

const ids = (records: { id: number }[]) => records.map(r => r.id);

/** Pending reply texts for one issue, oldest first. */
async function pendingTexts(cwd: string, id: number): Promise<string[]> {
	return (await listReplies(cwd)).filter(reply => reply.id === id).map(reply => reply.text);
}

/** Issue `id` is `sessionId`'s work: a live session holding its claim, as the `stage: running` op leaves it. */
async function hold(id: number, sessionId = "session-a"): Promise<void> {
	await touchPresence(tempDir, sessionId);
	expect(await claim(tempDir, id, sessionId)).toBe(true);
}

describe("issues store: replyToIssue", () => {
	afterEach(() => {
		setSystemTime();
	});

	it("rejects an empty reply or an unknown id without writing anything", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		const before = await Bun.file(record.filePath).text();

		for (const text of ["", "   \n\t  "]) {
			await expect(replyToIssue(tempDir, record.id, text)).rejects.toThrow("Reply is empty.");
		}
		await expect(replyToIssue(tempDir, 999, "Hello")).rejects.toThrow("Issue #999 not found.");

		expect(await Bun.file(record.filePath).text()).toBe(before);
		expect(await listReplies(tempDir)).toEqual([]);
		expect([...(await listQueued(tempDir))]).toEqual([]);
	});

	it("parks the reply in the local inbox; the git file only gains stage up-next and a new updated", async () => {
		const body = ["## Repro", "", "- step: one", "", "```ts", "const x = { a: 1 };", "```"].join("\n");
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Flaky deploy",
			body,
			severity: "high",
			location: ["src/deploy.ts:42"],
			extra: { stage: "needs-you", owner: "alice", priority: 2, links: ["pr://12"] },
		});
		const frontmatterBefore = await readFrontmatterOnDisk(record.filePath);
		// Everything under `.omp/issues` is what a commit would pick up.
		const trackedBefore = (await fs.readdir(getIssuesRoot(tempDir), { recursive: true })).sort();

		setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
		await replyToIssue(tempDir, record.id, "Use the arm runner.");
		const second = new Date("2026-03-01T00:00:00.000Z");
		setSystemTime(second);
		await replyToIssue(tempDir, record.id, "  And pin the image.\n");

		expect(await readFrontmatterOnDisk(record.filePath)).toEqual({
			...frontmatterBefore,
			stage: "up-next",
			updated: second.toISOString(),
		});
		expect((await findIssueById(tempDir, record.id))!.body).toBe(body);
		const text = await Bun.file(record.filePath).text();
		expect(text).not.toContain("arm runner");
		expect(text).not.toContain("pin the image");
		expect((await fs.readdir(getIssuesRoot(tempDir), { recursive: true })).sort()).toEqual(trackedBefore);

		expect(await pendingTexts(tempDir, record.id)).toEqual(["Use the arm runner.", "And pin the image."]);
		expect([...(await listQueued(tempDir))]).toEqual([record.id]);
	});

	const columns: Array<{
		name: string;
		status: IssueStatus;
		stage: IssueStage | undefined;
		expected: IssueStage | undefined;
	}> = [
		{ name: "explicit running stage stays running", status: "open", stage: "running", expected: "running" },
		{
			name: "in-progress with no stage stays stageless",
			status: "in-progress",
			stage: undefined,
			expected: undefined,
		},
		{ name: "in-progress parked in needs-you moves", status: "in-progress", stage: "needs-you", expected: "up-next" },
		{
			name: "in-progress awaiting deploy moves",
			status: "in-progress",
			stage: "awaiting-deploy",
			expected: "up-next",
		},
		{ name: "plain open work moves", status: "open", stage: undefined, expected: "up-next" },
		{ name: "deferred work moves", status: "open", stage: "deferred", expected: "up-next" },
	];
	for (const column of columns) {
		it(`Running-column exception: ${column.name}`, async () => {
			const { record } = await addIssue(tempDir, {
				category: "infra",
				title: "Flaky deploy",
				body: "B.",
				status: column.status,
				extra: column.stage === undefined ? {} : { stage: column.stage },
			});

			await replyToIssue(tempDir, record.id, "Any update?");
			await hold(record.id);

			const onDisk = await readFrontmatterOnDisk(record.filePath);
			expect(onDisk.stage).toBe(column.expected);
			expect("stage" in onDisk).toBe(column.expected !== undefined);
			expect(onDisk.status).toBe(column.status);
			// Whatever the column, the reply itself reaches the holder's turn-end queue.
			expect(await pendingTexts(tempDir, record.id)).toEqual(["Any update?"]);
			expect(ids(await listQueuedIssues(tempDir, "session-a"))).toEqual([record.id]);
		});
	}

	it("reopens an archived issue as open + up-next, with the reply pending and the issue queued", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		await archiveIssue(tempDir, record.id, { status: "wontfix", reason: "looked fine" });

		const replied = (await replyToIssue(tempDir, record.id, "Still broken on arm.")).record;

		expect(replied.archived).toBe(false);
		expect(replied.filePath).toBe(record.filePath);
		// One file for the id: the archive copy is retired, not duplicated.
		const all = await listIssueRecords(tempDir);
		expect(all.filter(r => r.id === record.id).map(r => r.archived)).toEqual([false]);

		const onDisk = await readFrontmatterOnDisk(record.filePath);
		expect(onDisk.status).toBe("open");
		expect(onDisk.stage).toBe("up-next");
		expect("archive_reason" in onDisk).toBe(false);
		expect(await pendingTexts(tempDir, record.id)).toEqual(["Still broken on arm."]);
		await hold(record.id);
		expect(ids(await listQueuedIssues(tempDir, "session-a"))).toEqual([record.id]);
	});

	it("hands a multi-line reply to the agent byte-for-byte", async () => {
		const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B." });
		await replyToIssue(tempDir, record.id, TRICKY_TEXT);

		const [pending] = await listReplies(tempDir);
		expect(pending.text).toBe(TRICKY_TEXT);
		expect(await takeReply(tempDir, pending, "session-a")).toBe(TRICKY_TEXT);
		expect(await listReplies(tempDir)).toEqual([]);
	});
});

describe("issues store: appendReplyHistory", () => {
	it("adds the ## Replies header once, appends entries in order, and adds no frontmatter keys", async () => {
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Flaky deploy",
			body: "Original body.",
			extra: { stage: "up-next" },
		});
		const { updated: _updatedBefore, ...frontmatterBefore } = await readFrontmatterOnDisk(record.filePath);

		await appendReplyHistory(tempDir, record.id, "Use the arm runner.", "2026-01-01T00:00:00.000Z");
		await appendReplyHistory(tempDir, record.id, `  ${TRICKY_TEXT}\n`, "2026-01-02T00:00:00.000Z");

		const after = (await findIssueById(tempDir, record.id))!;
		expect(after.body).toBe(
			[
				"Original body.",
				"",
				"## Replies",
				"",
				"### User reply · 2026-01-01T00:00:00.000Z",
				"",
				"Use the arm runner.",
				"",
				"### User reply · 2026-01-02T00:00:00.000Z",
				"",
				TRICKY_TEXT,
			].join("\n"),
		);
		const { updated: _updatedAfter, ...frontmatterAfter } = await readFrontmatterOnDisk(record.filePath);
		expect(frontmatterAfter).toEqual(frontmatterBefore);
	});

	it("returns undefined for an issue that vanished before delivery was recorded", async () => {
		expect(await appendReplyHistory(tempDir, 999, "Hello", "2026-01-01T00:00:00.000Z")).toBeUndefined();
		expect(await listIssueRecords(tempDir)).toEqual([]);
	});
});

describe("issues store: turn-end queue", () => {
	afterEach(() => {
		setSystemTime();
	});

	async function upNext(title: string) {
		return (await addIssue(tempDir, { category: "infra", title, body: "B.", extra: { stage: "up-next" } })).record;
	}

	it("a committed up-next stage without a local queue mark is not queued", async () => {
		const record = await upNext("Up next in a clone");
		await hold(record.id);
		expect(await listQueuedIssues(tempDir, "session-a")).toEqual([]);

		await setQueued(tempDir, record.id, true);
		expect(ids(await listQueuedIssues(tempDir, "session-a"))).toEqual([record.id]);
	});

	it("a queued issue the agent moved to running stays queued and keeps its mark", async () => {
		const record = await upNext("Flaky deploy");
		await setQueued(tempDir, record.id, true);
		await hold(record.id);

		await moveIssue(tempDir, record.id, { stage: "running" });

		expect(ids(await listQueuedIssues(tempDir, "session-a"))).toEqual([record.id]);
		expect([...(await listQueued(tempDir))]).toEqual([record.id]);
	});

	const movedOn: Array<{ name: string; act: (id: number) => Promise<unknown> }> = [
		{ name: "moved to needs-you", act: id => moveIssue(tempDir, id, { stage: "needs-you" }) },
		{ name: "moved to awaiting-deploy", act: id => moveIssue(tempDir, id, { stage: "awaiting-deploy" }) },
		{ name: "moved to deferred", act: id => moveIssue(tempDir, id, { stage: "deferred" }) },
		{ name: "unstaged", act: id => moveIssue(tempDir, id, { stage: null }) },
		{ name: "archived", act: id => archiveIssue(tempDir, id, { reason: "done" }) },
		{ name: "deleted", act: async id => fs.rm((await findIssueById(tempDir, id))!.filePath) },
	];
	for (const row of movedOn) {
		it(`a queued issue the agent ${row.name} leaves the queue and its mark is pruned`, async () => {
			const record = await upNext("Flaky deploy");
			const other = await upNext("Still queued");
			await setQueued(tempDir, record.id, true);
			await setQueued(tempDir, other.id, true);
			await hold(record.id);
			await hold(other.id);

			await row.act(record.id);

			expect(ids(await listQueuedIssues(tempDir, "session-a"))).toEqual([other.id]);
			expect([...(await listQueued(tempDir))]).toEqual([other.id]);
		});
	}

	it("puts replied issues first, oldest reply first, then queued issues by id", async () => {
		const queuedLow = await upNext("Queued low");
		const queuedHigh = await upNext("Queued high");
		const repliedLater = (
			await addIssue(tempDir, { category: "infra", title: "Replied later", body: "B.", extra: { stage: "running" } })
		).record;
		const repliedEarlier = (await addIssue(tempDir, { category: "infra", title: "Replied earlier", body: "B." }))
			.record;
		// Unqueued up-next work and other columns never show up, even when held.
		const notQueued = await upNext("Not queued here");
		const needsYou = (
			await addIssue(tempDir, { category: "infra", title: "Needs you", body: "B.", extra: { stage: "needs-you" } })
		).record;
		await setQueued(tempDir, queuedLow.id, true);
		await setQueued(tempDir, queuedHigh.id, true);
		// Reply order defeats id order: the higher id replied first.
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		await replyToIssue(tempDir, repliedEarlier.id, "First.");
		setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
		await replyToIssue(tempDir, repliedLater.id, "Second.");
		setSystemTime();
		for (const record of [queuedLow, queuedHigh, repliedLater, repliedEarlier, notQueued, needsYou]) {
			await hold(record.id);
		}

		expect(ids(await listQueuedIssues(tempDir, "session-a"))).toEqual([
			repliedEarlier.id,
			repliedLater.id,
			queuedLow.id,
			queuedHigh.id,
		]);
	});

	it("queues an issue only for the session holding it with a live claim", async () => {
		const free = await upNext("Nobody holds this");
		const mine = await upNext("Held by a");
		const theirs = await upNext("Held by b");
		const abandoned = await upNext("Held by a session that died");
		for (const record of [free, mine, theirs, abandoned]) {
			await replyToIssue(tempDir, record.id, "Any update?");
		}
		await hold(mine.id, "session-a");
		await hold(theirs.id, "session-b");
		await hold(abandoned.id, "session-c");
		// session-c stops beating; a and b refresh on the new clock.
		setSystemTime(new Date(Date.now() + PRESENCE_STALE_MS + 1_000));
		await touchPresence(tempDir, "session-a");
		await touchPresence(tempDir, "session-b");

		expect(ids(await listQueuedIssues(tempDir, "session-a"))).toEqual([mine.id]);
		expect(ids(await listQueuedIssues(tempDir, "session-b"))).toEqual([theirs.id]);
		// The stale holder is nobody's work until a session claims it again.
		expect(ids(await listQueuedIssues(tempDir, "session-c"))).toEqual([]);
		// Listing claims nothing: the free issue is still free, its reply still pending.
		expect(await claim(tempDir, free.id, "session-b")).toBe(true);
		expect(await pendingTexts(tempDir, free.id)).toEqual(["Any update?"]);
		expect(ids(await listQueuedIssues(tempDir, "session-b"))).toEqual([free.id, theirs.id]);
	});
});

describe("issues store: multi-line frontmatter values", () => {
	it("round-trips a multi-line value exactly through add, moves, archive, unarchive and a file rewrite", async () => {
		const { record } = await addIssue(tempDir, {
			category: "infra",
			title: "Flaky deploy",
			body: "B.",
			extra: { notes: TRICKY_TEXT },
		});
		const notesNow = async () => {
			const found = (await findIssueById(tempDir, record.id))!;
			return [found.frontmatter.notes, (await readFrontmatterOnDisk(found.filePath)).notes];
		};
		expect(await notesNow()).toEqual([TRICKY_TEXT, TRICKY_TEXT]);

		await moveIssue(tempDir, record.id, { stage: "running" });
		expect(await notesNow()).toEqual([TRICKY_TEXT, TRICKY_TEXT]);
		await archiveIssue(tempDir, record.id);
		expect(await notesNow()).toEqual([TRICKY_TEXT, TRICKY_TEXT]);
		await unarchiveIssue(tempDir, record.id);
		expect(await notesNow()).toEqual([TRICKY_TEXT, TRICKY_TEXT]);
		// An agent writing the file back exactly as it read it.
		await saveIssueContent(tempDir, record.id, await Bun.file(record.filePath).text());
		expect(await notesNow()).toEqual([TRICKY_TEXT, TRICKY_TEXT]);
	});
});

describe("issues store: report link", () => {
	const malformed = [
		"reports://personal/flaky-deploy",
		"report://personal",
		"report://personal/flaky/deploy",
		"report://personal/flaky deploy",
		"ftp://reports.example.com/x",
		"https://",
		"see report://personal/flaky-deploy",
	];

	it("addIssue rejects a malformed report before creating any file", async () => {
		for (const report of malformed) {
			await expect(
				addIssue(tempDir, { category: "infra", title: "Bad report", body: "B.", report }),
			).rejects.toThrow(/invalid report/);
		}
		expect(await listIssueRecords(tempDir)).toEqual([]);
		expect(await Bun.file(path.join(getIssuesRoot(tempDir), ".next-id")).exists()).toBe(false);
	});

	for (const report of [
		"report://personal/flaky-deploy",
		"https://reports.example.com/personal/flaky-deploy?v=2#top",
	]) {
		it(`keeps a ${report.split(":")[0]}:// report through moves, archive, unarchive and a reopening reply`, async () => {
			const { record } = await addIssue(tempDir, { category: "infra", title: "Flaky deploy", body: "B.", report });
			const reportOnDisk = async () =>
				(await readFrontmatterOnDisk((await findIssueById(tempDir, record.id))!.filePath)).report;
			expect(await reportOnDisk()).toBe(report);

			const steps: Array<() => Promise<unknown>> = [
				() => moveIssue(tempDir, record.id, { stage: "running" }),
				() => moveIssue(tempDir, record.id, { stage: null, status: "fixed", reason: "done" }),
				() => unarchiveIssue(tempDir, record.id),
				() => archiveIssue(tempDir, record.id, { status: "wontfix" }),
				() => replyToIssue(tempDir, record.id, "Reopen it."),
			];
			for (const step of steps) {
				await step();
				expect(await reportOnDisk()).toBe(report);
			}
		});
	}
});
