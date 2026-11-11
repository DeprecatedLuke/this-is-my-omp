/**
 * Project-local issue tracker storage.
 *
 * Layout under `<cwd>/.omp/issues`:
 *   <category>/<id>-<slug>.md       active issues
 *   .archive/<category>/<id>-<slug>.md archived issues
 *   .next-id                        single-line decimal counter
 *
 * The id is **global**: one counter across every category and across
 * active + archive, so each issue has a stable handle regardless of where
 * its file currently lives. The counter file is a hint — every write
 * re-scans active + archive on collision so two racing sessions can never
 * produce two files with the same id.
 *
 * Filenames carry the id as a left-anchored prefix (`<id>-<slug>.md`) and
 * are looked up by id alone via {@link findIssueById}; the slug part is for
 * human readability in `ls` and the URL handler accepts either form.
 *
 * Everything under `.omp/issues` is committed, so it holds only what belongs in
 * git: the issue itself, its `stage`, and the delivered-reply history in the
 * body. Pending replies, queue marks and session claims are machine-local and
 * live in the inbox ({@link ./inbox.ts}).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isEnotempty, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { addReply, claimIsStale, claimOwner, listQueued, listReplies, type PendingReply, setQueued } from "./inbox";

/** Severity bucket. */
export type IssueSeverity = "low" | "medium" | "high" | "critical";

/** Lifecycle status. The file's location (active vs archive) is the source
 *  of truth; `status` is metadata that the agent and renderers can read. */
export type IssueStatus = "open" | "in-progress" | "fixed" | "wontfix" | "duplicate";

/** Every stage, in board state order. */
export const ISSUE_STAGES = ["needs-you", "up-next", "running", "awaiting-deploy", "deferred"] as const;

/** Board stage: where an active issue sits beyond its status. Optional; an
 *  issue without one is plain open work. Archived issues never carry one. */
export type IssueStage = (typeof ISSUE_STAGES)[number];

export interface IssueFrontmatter {
	title: string;
	category?: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	stage?: IssueStage;
	/** What the issue waits on: in `needs-you`, the user's decision, approval or
	 *  action; in `awaiting-deploy`, the rollout to run. Only an active issue in
	 *  one of those stages carries it; every other write drops it. */
	needs?: string;
	/** Report this issue is written up in: `report://<project>/<slug>` or an `http(s)://` URL. */
	report?: string;
	/** Closing remarks: the outcome, set when the issue is archived and shown at
	 *  the top of it. Only an archived issue carries it; a move back drops it. */
	archive_reason?: string;
	location?: string[];
	created?: string;
	updated?: string;
	[key: string]: unknown;
}

export interface IssueRecord {
	id: number;
	category: string;
	slug: string;
	filename: string;
	/** Absolute filesystem path. */
	filePath: string;
	/** Relative path from `<root>` (e.g. `security/14-foo.md`). */
	relativePath: string;
	archived: boolean;
	frontmatter: IssueFrontmatter;
	body: string;
}

export interface IssueSummary {
	id: number;
	category: string;
	title: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	archived: boolean;
	updated?: string;
	created?: string;
	filename: string;
}

export interface AddIssueInput {
	category: string;
	title: string;
	body: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	/** Report URL this issue is written up in. */
	report?: string;
	/** Board stage to file the issue in. A terminal `status` carries none. */
	stage?: IssueStage;
	/** What the issue waits on; only with `stage: needs-you` or `awaiting-deploy`. */
	needs?: string;
	location?: string[];
	/** Extra frontmatter fields to merge in (e.g. `confidence`, `file_path`). */
	extra?: Record<string, unknown>;
}

export interface ListIssuesOptions {
	category?: string;
	archived?: boolean;
	severity?: IssueSeverity;
	status?: IssueStatus;
	/** Board stage; `"none"` matches issues carrying no stage at all. */
	stage?: IssueStage | "none";
	/** Plain-text query; case-insensitive substring match against title + body + frontmatter values. */
	query?: string;
	/** Hard limit on returned records (post-sort). */
	limit?: number;
}

const ISSUES_DIR = path.join(".omp", "issues");
const ARCHIVE_SEGMENT = ".archive";
const COUNTER_FILE = ".next-id";

const SLUG_MAX_WORDS = 5;
const SLUG_MAX_CHARS = 50;
const ID_FILENAME_RE = /^(\d+)-(.*)\.md$/;

export function getIssuesRoot(cwd: string): string {
	return path.join(cwd, ISSUES_DIR);
}

function getArchiveRoot(cwd: string): string {
	return path.join(getIssuesRoot(cwd), ARCHIVE_SEGMENT);
}

function getCounterPath(cwd: string): string {
	return path.join(getIssuesRoot(cwd), COUNTER_FILE);
}

/**
 * Normalize an arbitrary category string into a safe directory name. Throws on
 * segments that escape the issues root (path separators / `..`) or normalize to
 * an empty name.
 */
export function normalizeCategory(input: string): string {
	const trimmed = input.trim();
	if (!trimmed || /[\\/]|\.\.|^\.$/.test(trimmed)) {
		throw new Error(`Invalid issue category: ${JSON.stringify(input)}`);
	}
	const normalized = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!normalized) {
		throw new Error(`Invalid issue category: ${JSON.stringify(input)}`);
	}
	return normalized;
}

/**
 * Convert a human title into a filesystem slug:
 * lowercase, alphanumerics joined with `-`, first {@link SLUG_MAX_WORDS}
 * words, capped at {@link SLUG_MAX_CHARS} chars. Empty input yields
 * `"untitled"` so we never produce `<id>-.md`.
 */
export function slugifyTitle(title: string): string {
	const words = title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]+/g, " ")
		.split(/[\s-]+/)
		.filter(Boolean)
		.slice(0, SLUG_MAX_WORDS);
	const joined = words.join("-").slice(0, SLUG_MAX_CHARS).replace(/-+$/g, "");
	return joined || "untitled";
}

function parseIdFromFilename(filename: string): number | undefined {
	const match = filename.match(ID_FILENAME_RE);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseSlugFromFilename(filename: string): string {
	const match = filename.match(ID_FILENAME_RE);
	return match?.[2] ?? "";
}

async function listSubdirs(root: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

interface FilesystemScan {
	/** All issue records found, regardless of archive state. */
	records: Array<{ id: number; filePath: string; filename: string; category: string; archived: boolean }>;
	/** Max id across active + archive (0 when no issues exist). */
	maxId: number;
}

async function scanFilesystem(cwd: string): Promise<FilesystemScan> {
	const issuesRoot = getIssuesRoot(cwd);
	const archiveRoot = getArchiveRoot(cwd);
	const records: FilesystemScan["records"] = [];
	let maxId = 0;

	const activeCategories = (await listSubdirs(issuesRoot)).filter(name => name !== ARCHIVE_SEGMENT);
	for (const category of activeCategories) {
		const dir = path.join(issuesRoot, category);
		const files = await listMarkdownFiles(dir);
		for (const filename of files) {
			const id = parseIdFromFilename(filename);
			if (id === undefined) continue;
			records.push({ id, filePath: path.join(dir, filename), filename, category, archived: false });
			if (id > maxId) maxId = id;
		}
	}

	const archiveCategories = await listSubdirs(archiveRoot);
	for (const category of archiveCategories) {
		const dir = path.join(archiveRoot, category);
		const files = await listMarkdownFiles(dir);
		for (const filename of files) {
			const id = parseIdFromFilename(filename);
			if (id === undefined) continue;
			records.push({ id, filePath: path.join(dir, filename), filename, category, archived: true });
			if (id > maxId) maxId = id;
		}
	}

	return { records, maxId };
}

async function readCounter(cwd: string): Promise<number | undefined> {
	try {
		const text = (await Bun.file(getCounterPath(cwd)).text()).trim();
		if (!text) return undefined;
		const value = Number(text);
		return Number.isFinite(value) && value > 0 ? value : undefined;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

async function writeCounter(cwd: string, next: number): Promise<void> {
	await Bun.write(getCounterPath(cwd), `${next}\n`);
}

/**
 * Reserve the next global id. Uses the counter file as a hint and falls back to
 * a full scan if the counter is missing, stale, or contended. Returns the id the
 * caller must immediately use to create a file. Callers serialize this with the
 * file creation via {@link withIdAllocationLock} so concurrent in-process adds
 * (e.g. several `issues add` calls in one turn) never hand out the same id.
 */
async function allocateId(cwd: string): Promise<number> {
	const counter = await readCounter(cwd);
	const scan = await scanFilesystem(cwd);
	// Pick max(counter, scan.maxId + 1) so we never reuse an id even if the
	// counter was deleted by a stale checkout.
	const candidate = Math.max(counter ?? 1, scan.maxId + 1);
	// Sanity check: candidate must not collide with any existing record.
	let id = candidate;
	const used = new Set(scan.records.map(r => r.id));
	while (used.has(id)) id += 1;
	return id;
}

function buildFilename(id: number, slug: string): string {
	return `${id}-${slug}.md`;
}

const YAML_NEEDS_QUOTE = /[:#&*!|>'"%@`{}[\]]|^[-?]|^\s|\s$|^$/;
function yamlScalar(value: string): string {
	// Single-quoted scalars fold line breaks into spaces; a JSON string is a valid
	// YAML double-quoted scalar that keeps every `\n` intact.
	if (/[\r\n]/.test(value)) return JSON.stringify(value);
	if (!YAML_NEEDS_QUOTE.test(value)) return value;
	// Single-quote with internal `'` doubled — covers every printable ASCII +
	// Unicode case we ever put in frontmatter (titles, paths, statuses).
	return `'${value.replace(/'/g, "''")}'`;
}

function yamlValueLine(key: string, value: unknown): string[] {
	if (value === null || value === undefined) return [`${key}: null`];
	if (typeof value === "boolean" || typeof value === "number") return [`${key}: ${value}`];
	if (typeof value === "string") return [`${key}: ${yamlScalar(value)}`];
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${key}: []`];
		const items = value
			.filter((item): item is string => typeof item === "string")
			.map(item => `  - ${yamlScalar(item)}`);
		return [`${key}:`, ...items];
	}
	// Fallback for unexpected object values — JSON-encode on a single line.
	return [`${key}: ${YAML.stringify(value).trim()}`];
}

function formatFrontmatter(frontmatter: IssueFrontmatter): string {
	const preferred = [
		"title",
		"category",
		"severity",
		"status",
		"stage",
		"needs",
		"report",
		"created",
		"updated",
		"location",
	];
	const lines: string[] = [];
	for (const key of preferred) {
		if (frontmatter[key] !== undefined) lines.push(...yamlValueLine(key, frontmatter[key]));
	}
	for (const [key, value] of Object.entries(frontmatter)) {
		if (preferred.includes(key)) continue;
		if (value !== undefined) lines.push(...yamlValueLine(key, value));
	}
	return `---\n${lines.join("\n")}\n---\n`;
}

function serializeIssue(frontmatter: IssueFrontmatter, body: string): string {
	const trimmedBody = body.replace(/^\s+/, "").replace(/\s+$/, "");
	if (!trimmedBody) {
		return formatFrontmatter(frontmatter);
	}
	return `${formatFrontmatter(frontmatter)}\n${trimmedBody}\n`;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map(item => (typeof item === "string" ? item.trim() : "")).filter(item => item.length > 0);
	return out.length > 0 ? out : undefined;
}

function coerceFrontmatter(raw: Record<string, unknown>): IssueFrontmatter {
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	const out: IssueFrontmatter = { title: title || "(untitled)" };
	if (typeof raw.category === "string") out.category = raw.category;
	if (typeof raw.severity === "string") out.severity = raw.severity as IssueSeverity;
	if (typeof raw.status === "string") out.status = raw.status as IssueStatus;
	if (typeof raw.stage === "string") out.stage = raw.stage as IssueStage;
	if (typeof raw.needs === "string") out.needs = raw.needs;
	if (typeof raw.report === "string") out.report = raw.report;
	if (typeof raw.archive_reason === "string") out.archive_reason = raw.archive_reason;
	if (typeof raw.created === "string") out.created = raw.created;
	if (typeof raw.updated === "string") out.updated = raw.updated;
	const location = asStringArray(raw.location);
	if (location) out.location = location;
	for (const [key, value] of Object.entries(raw)) {
		if (key in out) continue;
		out[key] = value;
	}
	return out;
}

async function readIssueFromPath(
	filePath: string,
	id: number,
	category: string,
	archived: boolean,
): Promise<IssueRecord> {
	const filename = path.basename(filePath);
	const content = await Bun.file(filePath).text();
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath, normalize: false });
	const slug = parseSlugFromFilename(filename);
	return {
		id,
		category,
		slug,
		filename,
		filePath,
		relativePath: archived ? path.join(ARCHIVE_SEGMENT, category, filename) : path.join(category, filename),
		archived,
		frontmatter: coerceFrontmatter(frontmatter),
		body,
	};
}

/** Find an issue by global id, looking in active and then archive. */
export async function findIssueById(cwd: string, id: number): Promise<IssueRecord | undefined> {
	const scan = await scanFilesystem(cwd);
	const match = scan.records.find(r => r.id === id);
	if (!match) return undefined;
	return readIssueFromPath(match.filePath, match.id, match.category, match.archived);
}

/**
 * Find an issue by basename. Accepts:
 * - `<id>-<slug>.md` (exact file)
 * - `<id>.md` (id-only convenience)
 * - `<id>` (no extension)
 * - `<id>-<slug>` (no extension)
 */
export async function findIssueByFilename(cwd: string, basename: string): Promise<IssueRecord | undefined> {
	const cleaned = basename.replace(/\.md$/i, "");
	const match = cleaned.match(/^(\d+)(?:-(.*))?$/);
	if (!match) return undefined;
	const id = Number(match[1]);
	if (!Number.isFinite(id) || id <= 0) return undefined;
	return findIssueById(cwd, id);
}

function recordToSummary(record: IssueRecord): IssueSummary {
	return {
		id: record.id,
		category: record.category,
		title: record.frontmatter.title,
		severity: record.frontmatter.severity,
		status: record.frontmatter.status,
		archived: record.archived,
		updated: record.frontmatter.updated,
		created: record.frontmatter.created,
		filename: record.filename,
	};
}

/**
 * Every issue, active and archived, with full frontmatter and body, from one
 * filesystem scan. Unlike {@link listIssues} this keeps the records (not
 * summaries) and applies no filtering — the board needs the whole set at once.
 */
export async function listIssueRecords(cwd: string): Promise<IssueRecord[]> {
	const scan = await scanFilesystem(cwd);
	const records: IssueRecord[] = [];
	for (const entry of scan.records) {
		try {
			records.push(await readIssueFromPath(entry.filePath, entry.id, entry.category, entry.archived));
		} catch (err) {
			// A concurrent archive/unarchive can retire a file between the scan
			// and the read; the next scan sees its new location.
			if (isEnoent(err)) continue;
			throw err;
		}
	}
	records.sort((a, b) => b.id - a.id);
	return records;
}

/**
 * List issues, optionally filtered. Active issues are returned by default;
 * pass `archived: true` for archived only, or omit the filter to get both.
 */
export async function listIssues(cwd: string, options: ListIssuesOptions = {}): Promise<IssueSummary[]> {
	const scan = await scanFilesystem(cwd);
	const records: IssueRecord[] = [];
	for (const entry of scan.records) {
		if (options.archived !== undefined && entry.archived !== options.archived) continue;
		if (options.category && entry.category !== normalizeCategory(options.category)) continue;
		records.push(await readIssueFromPath(entry.filePath, entry.id, entry.category, entry.archived));
	}

	const query = options.query?.trim().toLowerCase();
	const filtered = records.filter(record => {
		if (options.severity && record.frontmatter.severity !== options.severity) return false;
		if (options.status && record.frontmatter.status !== options.status) return false;
		if (options.stage !== undefined && (record.frontmatter.stage ?? "none") !== options.stage) return false;
		if (!query) return true;
		if (record.frontmatter.title.toLowerCase().includes(query)) return true;
		if (record.body.toLowerCase().includes(query)) return true;
		for (const value of Object.values(record.frontmatter)) {
			if (typeof value === "string" && value.toLowerCase().includes(query)) return true;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === "string" && item.toLowerCase().includes(query)) return true;
				}
			}
		}
		return false;
	});

	// Newest first by id (proxy for creation order).
	filtered.sort((a, b) => b.id - a.id);
	const summaries = filtered.map(recordToSummary);
	if (options.limit !== undefined && options.limit > 0) {
		return summaries.slice(0, options.limit);
	}
	return summaries;
}

function nowIso(): string {
	return new Date().toISOString();
}

export interface AddIssueResult {
	record: IssueRecord;
	created: true;
}

// Serialize id allocation + file creation per issues root. `allocateId` reads
// the counter and scans the tree; without serialization two concurrent adds
// race between scan and write and hand out the same id — the `wx` create does
// not catch it because the filename embeds the slug, so same-id/different-slug
// files never collide on disk. This in-process mutex (a per-root promise chain)
// closes that window; cross-process races still fall back to the scan + `wx`
// retry below.
const idAllocationChains = new Map<string, Promise<unknown>>();
function withIdAllocationLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const key = getIssuesRoot(cwd);
	const prev = idAllocationChains.get(key) ?? Promise.resolve();
	const run = prev.then(fn, fn);
	// Tail swallows errors so one failed add never wedges the next.
	idAllocationChains.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

const MAX_ID_ALLOCATION_ATTEMPTS = 16;

export async function addIssue(cwd: string, input: AddIssueInput): Promise<AddIssueResult> {
	const category = normalizeCategory(input.category);
	const title = input.title.trim();
	if (!title) {
		throw new Error("Issue title is required.");
	}
	const body = input.body.replace(/\r\n?/g, "\n").trim();
	if (!body) {
		throw new Error("Issue body is required.");
	}
	assertValidStage(input.stage, "Issue rejected: ");
	assertValidNeeds(input.needs, "Issue rejected: ");
	if (input.needs !== undefined && !stageCarriesNeeds(input.stage)) {
		throw new Error(`Issue rejected: ${NEEDS_STAGE_ONLY}`);
	}
	const status = input.status ?? "open";
	if (input.stage !== undefined && !ACTIVE_STATUSES.has(status)) {
		throw new Error(`Issue rejected: a '${status}' issue is archived work and carries no stage.`);
	}

	const slug = slugifyTitle(title);
	const dir = path.join(getIssuesRoot(cwd), category);
	const createdAt = nowIso();
	const frontmatter: IssueFrontmatter = withBoardInvariants(
		{
			title,
			category,
			severity: input.severity,
			status,
			stage: input.stage,
			needs: input.needs,
			created: createdAt,
			updated: createdAt,
			report: input.report,
			location: input.location && input.location.length > 0 ? input.location : undefined,
			...input.extra,
		},
		false,
	);
	assertValidStage(frontmatter.stage, "Issue rejected: ");
	assertValidNeeds(frontmatter.needs, "Issue rejected: ");
	assertValidReport(frontmatter.report, "Issue rejected: ");
	const content = serializeIssue(frontmatter, body);

	return withIdAllocationLock(cwd, async () => {
		await fs.mkdir(dir, { recursive: true });
		for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt++) {
			const id = await allocateId(cwd);
			const filePath = path.join(dir, buildFilename(id, slug));
			let handle: fs.FileHandle | undefined;
			try {
				// `wx` fails with EEXIST if a racing *process* created the same
				// file between our scan and write, so we never clobber it.
				handle = await fs.open(filePath, "wx");
				await handle.writeFile(content);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw err;
			} finally {
				await handle?.close();
			}
			await writeCounter(cwd, id + 1).catch(() => {
				// Counter is a hint — failing to update it is not fatal; the next
				// allocation falls back to a scan.
			});
			const record = await readIssueFromPath(filePath, id, category, false);
			return { record, created: true };
		}
		throw new Error("Failed to allocate a unique issue id; the issues store may be contended.");
	});
}

export interface EditIssueResult {
	record: IssueRecord;
	/** `true` when the issue moved to a different category. */
	moved: boolean;
	/** `true` when the on-disk filename slug changed. */
	renamed: boolean;
	/** `true` when the edit toggled the active/archive side via status. */
	transitioned: boolean;
	/** Archive side before the edit. Useful to render "→ archived"/"→ active". */
	wasArchived: boolean;
}

/**
 * Statuses that keep an issue on the active side. Anything else — `fixed`,
 * `wontfix`, `duplicate`, or any future non-active status — belongs in the
 * archive, so a status edit that leaves this set auto-moves the file. Mirrors
 * the defaults used by {@link archiveIssue} (status: fixed) and
 * {@link unarchiveIssue} (status: open).
 */
const ACTIVE_STATUSES: ReadonlySet<IssueStatus> = new Set(["open", "in-progress"]);

/** Statuses accepted in issue frontmatter (the metadata-edit validation set). */
const ISSUE_STATUSES: ReadonlySet<string> = new Set<IssueStatus>([
	"open",
	"in-progress",
	"fixed",
	"wontfix",
	"duplicate",
]);
/** Severities accepted in issue frontmatter (the metadata-edit validation set). */
const ISSUE_SEVERITIES: ReadonlySet<string> = new Set<IssueSeverity>(["low", "medium", "high", "critical"]);
/** Stages accepted in issue frontmatter (the board's state set). */
const ISSUE_STAGE_SET: ReadonlySet<string> = new Set<string>(ISSUE_STAGES);
/** A `report://<project>/<slug>` handle or an absolute `http(s)://` URL. */
const REPORT_URL_RE = /^(?:report:\/\/[^/\s?#]+\/[^/\s?#]+|https?:\/\/[^\s/?#]+\S*)$/;

/**
 * Reject a `stage` outside {@link ISSUE_STAGES}. `label` names the write path so
 * the message reads like the surrounding status/severity rejections.
 */
function assertValidStage(stage: unknown, label: string): void {
	if (stage === undefined || stage === null) return;
	if (typeof stage === "string" && ISSUE_STAGE_SET.has(stage)) return;
	throw new Error(`${label}invalid stage '${String(stage)}'. Use one of: ${ISSUE_STAGES.join(", ")}.`);
}

/** Why an agent write into `needs-you` without a `needs` text is refused. */
export const NEEDS_REQUIRED =
	"`stage: needs-you` needs a `needs` text: what you need from the user — the decision, approval or action they must take.";

/** Why a `needs` text on any stage but `needs-you` or `awaiting-deploy` is refused. */
export const NEEDS_STAGE_ONLY = "`needs` goes only with stage `needs-you` or `awaiting-deploy`.";

const NEEDS_STAGE: Readonly<Record<string, true>> = { "needs-you": true, "awaiting-deploy": true };

/** True for the stages that may carry a `needs` text. */
export function stageCarriesNeeds(stage: IssueStage | "none" | null | undefined): boolean {
	return typeof stage === "string" && NEEDS_STAGE[stage] === true;
}

/**
 * Reject a `needs` that is not a non-empty string. It is prose, so there is no
 * enum to check — only that the agent actually said what it needs.
 */
function assertValidNeeds(needs: unknown, label: string): void {
	if (needs === undefined || needs === null) return;
	if (typeof needs === "string" && needs.trim().length > 0) return;
	throw new Error(`${label}\`needs\` must be a non-empty string: say what you need from the user.`);
}

/** What closing remarks are, for every prompt and rejection that asks for them. */
export const CLOSING_REMARKS =
	"the outcome in one to three plain sentences (what shipped and where, or why it was dropped or duplicated), shown at the top of the issue";

/** Why an agent write that closes an active issue without closing remarks is refused. */
export const CLOSING_REMARKS_REQUIRED = `closing an issue needs closing remarks: set \`archive_reason\` (or use the \`archive\` op's \`reason\`) to ${CLOSING_REMARKS}.`;

/** Reject an `archive_reason` that is not a non-empty string. */
function assertValidArchiveReason(reason: unknown, label: string): void {
	if (reason === undefined || reason === null) return;
	if (typeof reason === "string" && reason.trim().length > 0) return;
	throw new Error(`${label}\`archive_reason\` must be a non-empty string: the closing remarks, ${CLOSING_REMARKS}.`);
}

/**
 * Enforce the board invariants every write must hold: an archived issue carries
 * no `stage` (so an unarchive never resurrects a stale one), and only an active
 * `needs-you` or `awaiting-deploy` issue carries `needs`, so every other write
 * drops the key. Trims the text when it survives.
 */
function withBoardInvariants(frontmatter: IssueFrontmatter, archived: boolean): IssueFrontmatter {
	if (archived) delete frontmatter.stage;
	if (archived || !stageCarriesNeeds(frontmatter.stage)) {
		delete frontmatter.needs;
		return frontmatter;
	}
	if (frontmatter.needs !== undefined) frontmatter.needs = frontmatter.needs.trim();
	return frontmatter;
}

/**
 * Reject a `report` that is neither a `report://<project>/<slug>` handle nor an
 * `http(s)://` URL, so the board never renders a dead link.
 */
function assertValidReport(report: unknown, label: string): void {
	if (report === undefined || report === null) return;
	if (typeof report === "string" && REPORT_URL_RE.test(report)) return;
	throw new Error(`${label}invalid report '${String(report)}'. Use report://<project>/<slug> or an http(s):// URL.`);
}

function shouldBeArchived(status: IssueStatus | undefined, currentArchived: boolean): boolean {
	if (!status) return currentArchived;
	return !ACTIVE_STATUSES.has(status);
}

/**
 * Remove a now-empty category directory after its last issue moved out. The
 * issues/archive roots themselves are preserved (they anchor the tracker and
 * hold the counter file); only per-category subdirectories are pruned, plus the
 * archive root once its last category is gone. `rmdir` (non-recursive) only
 * succeeds on an empty dir, so a category that still holds issues — or a same-dir
 * slug rename, where the new file already landed — fails atomically with
 * ENOTEMPTY and is left intact. Best-effort: a failure to prune never fails the
 * move that already succeeded.
 */
async function pruneEmptyCategoryDir(cwd: string, categoryDir: string): Promise<void> {
	const issuesRoot = getIssuesRoot(cwd);
	const archiveRoot = getArchiveRoot(cwd);
	// Never prune the roots via the category path (the archive root is handled
	// as a follow-up below); only a true per-category subdirectory is eligible.
	if (categoryDir === issuesRoot || categoryDir === archiveRoot) return;
	try {
		await fs.rmdir(categoryDir);
	} catch (err) {
		if (isEnotempty(err) || isEnoent(err)) return;
		throw err;
	}
	// An archived category sits under the archive root; once the last category
	// is pruned the archive root is empty too, so retire it (it is recreated on
	// demand by the next archive). The issues root is never pruned.
	if (path.dirname(categoryDir) === archiveRoot) {
		try {
			await fs.rmdir(archiveRoot);
		} catch (err) {
			if (isEnotempty(err) || isEnoent(err)) return;
			throw err;
		}
	}
}

/**
 * Write `frontmatter` + `body` to the issue's target location, then drop the old
 * file when the target differs. Every lifecycle transition (archive, unarchive,
 * metadata edit, board move) goes through here so they all create the target
 * directory, retire the source file, and prune an emptied category the same way.
 */
async function writeIssueRecord(
	cwd: string,
	current: IssueRecord,
	target: { category: string; filename: string; archived: boolean },
	frontmatter: IssueFrontmatter,
	body: string,
): Promise<IssueRecord> {
	const root = target.archived ? getArchiveRoot(cwd) : getIssuesRoot(cwd);
	const dir = path.join(root, target.category);
	const filePath = path.join(dir, target.filename);
	// The one choke point every record write passes through, so the board
	// invariants hold no matter which op (or `issues://` edit) produced it.
	withBoardInvariants(frontmatter, target.archived);
	assertValidNeeds(frontmatter.needs, "Issue write rejected: ");
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(filePath, serializeIssue(frontmatter, body));
	if (filePath !== current.filePath) {
		await fs.rm(current.filePath, { force: true });
		await pruneEmptyCategoryDir(cwd, path.dirname(current.filePath));
	}
	return readIssueFromPath(filePath, current.id, target.category, target.archived);
}

/**
 * Parse and validate an edited issue file (frontmatter + body). The frontmatter
 * is the metadata layer the store derives title/status/category from, so a write
 * that drops the `---` fences, ships unparseable YAML, or carries an out-of-enum
 * `status`/`severity` is rejected before it can corrupt the record. Throws a
 * descriptive `Error` naming the failure.
 */
function parseIssueFileContent(content: string, source: string): { frontmatter: IssueFrontmatter; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---") || normalized.indexOf("\n---", 3) === -1) {
		throw new Error(
			"issues:// write rejected: the file must open with a `---` YAML frontmatter block and close it with a `---` line — title/status/severity live there. Keep both fences intact when editing.",
		);
	}
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(normalized, { source, normalize: false, level: "fatal" });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`issues:// write rejected: the frontmatter does not parse as YAML (${detail}). Keep the \`---\` fences and YAML block intact when editing.`,
		);
	}
	const frontmatter = coerceFrontmatter(parsed.frontmatter);
	const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title.trim() : "";
	if (!title) {
		throw new Error("issues:// write rejected: the frontmatter `title` is required and must be a non-empty string.");
	}
	if (frontmatter.status !== undefined && !ISSUE_STATUSES.has(frontmatter.status)) {
		throw new Error(
			`issues:// write rejected: invalid status '${frontmatter.status}'. Use one of: open, in-progress, fixed, wontfix, duplicate.`,
		);
	}
	if (frontmatter.severity !== undefined && !ISSUE_SEVERITIES.has(frontmatter.severity)) {
		throw new Error(
			`issues:// write rejected: invalid severity '${frontmatter.severity}'. Use one of: low, medium, high, critical.`,
		);
	}
	assertValidStage(frontmatter.stage, "issues:// write rejected: ");
	assertValidNeeds(frontmatter.needs, "issues:// write rejected: ");
	assertValidReport(frontmatter.report, "issues:// write rejected: ");
	assertValidArchiveReason(frontmatter.archive_reason, "issues:// write rejected: ");
	frontmatter.title = title;
	return { frontmatter, body: parsed.body };
}

/**
 * Persist a full edited issue file by id. This is the single metadata-edit
 * surface: the `issues://<id>.md` write path routes here, so editing the
 * frontmatter drives the same lifecycle a structured edit once did — a terminal
 * `status` archives the file, a `category` change moves it, a `title` change
 * re-derives the slug — while the body is replaced from the same write. The
 * file is authoritative for metadata; `created`/`updated` are managed here, not
 * taken from the edited text.
 */
export async function saveIssueContent(cwd: string, id: number, content: string): Promise<EditIssueResult> {
	const current = await findIssueById(cwd, id);
	if (!current) {
		throw new Error(`Issue #${id} not found.`);
	}

	const { frontmatter: edited, body } = parseIssueFileContent(content, current.filePath);

	const nextTitle = edited.title;
	const nextCategory = edited.category ? normalizeCategory(edited.category) : current.category;
	const nextStatus = edited.status ?? current.frontmatter.status;
	const nextArchived = shouldBeArchived(nextStatus, current.archived);

	const frontmatter: IssueFrontmatter = {
		...edited,
		title: nextTitle,
		category: nextCategory,
		status: nextStatus,
		created: current.frontmatter.created ?? edited.created,
		updated: nowIso(),
	};
	// `archive_reason` holds the closing remarks, so it only makes sense while
	// archived: drop it on the way back to active, as `unarchiveIssue` does. An
	// agent write that closes an active issue must say how it ended; a rewrite
	// of an archived one keeps the remarks when the edit dropped the line.
	if (!nextArchived) {
		delete frontmatter.archive_reason;
	} else if (frontmatter.archive_reason !== undefined) {
		frontmatter.archive_reason = frontmatter.archive_reason.trim();
	} else if (!current.archived) {
		throw new Error(`issues:// write rejected: ${CLOSING_REMARKS_REQUIRED}`);
	} else if (typeof current.frontmatter.archive_reason === "string" && current.frontmatter.archive_reason.trim()) {
		frontmatter.archive_reason = current.frontmatter.archive_reason;
	}
	// The `needs` text follows the stage on this path too, as on the `stage` op:
	// a rewrite that keeps the stage keeps the text when the edit dropped the
	// line; one that changes it carries only text the edit wrote anew, so the
	// old line an agent left while flipping the stage is dropped; and one that
	// newly lands an issue in `needs-you` must say what it needs.
	const sameStage = !current.archived && current.frontmatter.stage === frontmatter.stage;
	if (
		!sameStage &&
		frontmatter.needs !== undefined &&
		frontmatter.needs.trim() === current.frontmatter.needs?.trim()
	) {
		delete frontmatter.needs;
	}
	if (!nextArchived && stageCarriesNeeds(frontmatter.stage) && frontmatter.needs === undefined) {
		if (sameStage) {
			frontmatter.needs = current.frontmatter.needs;
		} else if (frontmatter.stage === "needs-you") {
			throw new Error(`issues:// write rejected: ${NEEDS_REQUIRED}`);
		}
	}

	const nextSlug = slugifyTitle(nextTitle);
	const nextFilename = buildFilename(current.id, nextSlug);

	const moved = nextCategory !== current.category;
	const renamed = nextFilename !== current.filename;
	const transitioned = nextArchived !== current.archived;

	const record = await writeIssueRecord(
		cwd,
		current,
		{ category: nextCategory, filename: nextFilename, archived: nextArchived },
		frontmatter,
		body,
	);
	return { record, moved, renamed, transitioned, wasArchived: current.archived };
}

export interface ArchiveResult {
	record: IssueRecord;
	wasArchived: boolean;
}

/** Move an active issue to the archive (no-op if already archived). */
export async function archiveIssue(
	cwd: string,
	id: number,
	options: { reason?: string; status?: IssueStatus } = {},
): Promise<ArchiveResult> {
	const current = await findIssueById(cwd, id);
	if (!current) throw new Error(`Issue #${id} not found.`);
	if (current.archived) {
		return { record: current, wasArchived: true };
	}

	const frontmatter: IssueFrontmatter = {
		...current.frontmatter,
		status: options.status ?? "fixed",
		updated: nowIso(),
	};
	if (options.reason !== undefined && options.reason.trim().length > 0) {
		frontmatter.archive_reason = options.reason.trim();
	}

	const record = await writeIssueRecord(
		cwd,
		current,
		{ category: current.category, filename: current.filename, archived: true },
		frontmatter,
		current.body,
	);
	return { record, wasArchived: false };
}

export interface UnarchiveResult {
	record: IssueRecord;
	wasActive: boolean;
}

/** Move an archived issue back to active. */
export async function unarchiveIssue(
	cwd: string,
	id: number,
	options: { status?: IssueStatus } = {},
): Promise<UnarchiveResult> {
	const current = await findIssueById(cwd, id);
	if (!current) throw new Error(`Issue #${id} not found.`);
	if (!current.archived) {
		return { record: current, wasActive: true };
	}

	const frontmatter: IssueFrontmatter = {
		...current.frontmatter,
		status: options.status ?? "open",
		updated: nowIso(),
	};
	delete frontmatter.archive_reason;

	const record = await writeIssueRecord(
		cwd,
		current,
		{ category: current.category, filename: current.filename, archived: false },
		frontmatter,
		current.body,
	);
	return { record, wasActive: false };
}

export interface IssueMove {
	/** Target stage; `null` clears the key. */
	stage: IssueStage | null;
	/** What the issue waits on; only with `stage: "needs-you"` or `"awaiting-deploy"`. */
	needs?: string;
	/** Target status. A terminal one archives, an active one unarchives. */
	status?: IssueStatus;
	/** Recorded as `archive_reason` when the move lands in the archive. */
	reason?: string;
}

/**
 * Move an issue to a board state: set or clear its `stage`, and optionally
 * drive the lifecycle with `status` (terminal archives, active unarchives).
 * The record is re-read from disk immediately before the write, so a concurrent
 * agent edit is never clobbered by a stale in-memory copy; every other
 * frontmatter key and the body survive untouched, and `updated` is bumped.
 */
export async function moveIssue(cwd: string, id: number, move: IssueMove): Promise<IssueRecord> {
	assertValidStage(move.stage, "Issue move rejected: ");
	assertValidNeeds(move.needs, "Issue move rejected: ");
	if (move.needs !== undefined && !stageCarriesNeeds(move.stage)) {
		throw new Error(`Issue move rejected: ${NEEDS_STAGE_ONLY}`);
	}
	if (move.status !== undefined && !ISSUE_STATUSES.has(move.status)) {
		throw new Error(
			`Issue move rejected: invalid status '${move.status}'. Use one of: open, in-progress, fixed, wontfix, duplicate.`,
		);
	}

	const current = await findIssueById(cwd, id);
	if (!current) throw new Error(`Issue #${id} not found.`);

	const nextStatus = move.status ?? current.frontmatter.status;
	const nextArchived = shouldBeArchived(nextStatus, current.archived);
	const frontmatter: IssueFrontmatter = {
		...current.frontmatter,
		status: nextStatus,
		updated: nowIso(),
	};
	// `stage` only describes active work; the archive is terminal.
	if (move.stage === null || nextArchived) {
		delete frontmatter.stage;
	} else {
		frontmatter.stage = move.stage;
	}
	// The `needs` text follows the stage: a move that carries it sets it, one
	// that leaves the stage as it was keeps the existing text (the board's state
	// key sets the stage without touching the text), one that changes the stage
	// drops it so a needs-you question never rides into awaiting-deploy, and the
	// write below drops it on every stage that cannot carry it.
	if (move.needs !== undefined) {
		frontmatter.needs = move.needs;
	} else if (current.archived || frontmatter.stage !== current.frontmatter.stage) {
		delete frontmatter.needs;
	}
	if (nextArchived) {
		if (move.reason !== undefined && move.reason.trim().length > 0) {
			frontmatter.archive_reason = move.reason.trim();
		}
	} else {
		delete frontmatter.archive_reason;
	}

	return writeIssueRecord(
		cwd,
		current,
		{ category: current.category, filename: current.filename, archived: nextArchived },
		frontmatter,
		current.body,
	);
}

/**
 * True when the issue is in the board's Running state: an explicit `running`
 * stage, or `status: in-progress` with no stage at all. A reply to such an issue
 * must not drag it out of Running.
 */
function isRunningColumn(record: IssueRecord): boolean {
	if (record.archived) return false;
	const stage = record.frontmatter.stage;
	if (stage !== undefined) return stage === "running";
	return record.frontmatter.status === "in-progress";
}

export interface ReplyToIssueResult {
	record: IssueRecord;
	/** The queued reply, now pending in the local inbox. */
	reply: PendingReply;
}

/**
 * Queue a user reply (typed on `omp-board`) for the next agent prompt. The reply
 * text is machine-local — it lives in the inbox, never in the git-tracked issue —
 * so a commit can neither ship a session's half-delivered reply nor let a cloned
 * repo's text drive an agent. The git side only records that the user wants this
 * worked: an archived issue reopens as `open` + `up-next`, a Running issue keeps
 * its stage, and everything else moves to `up-next`.
 */
export async function replyToIssue(root: string, id: number, text: string): Promise<ReplyToIssueResult> {
	const trimmed = text.trim();
	if (trimmed.length === 0) throw new Error("Reply is empty.");
	const found = await findIssueById(root, id);
	if (!found) throw new Error(`Issue #${id} not found.`);

	const reply = await addReply(root, id, trimmed);
	await setQueued(root, id, true);

	const frontmatter: IssueFrontmatter = { ...found.frontmatter, updated: nowIso() };
	if (found.archived) {
		// The user asking for work is a new lifecycle: reopen it on the board.
		frontmatter.status = "open";
		frontmatter.stage = "up-next";
		delete frontmatter.archive_reason;
	} else if (!isRunningColumn(found)) {
		frontmatter.stage = "up-next";
	}
	const record = await writeIssueRecord(
		root,
		found,
		{ category: found.category, filename: found.filename, archived: false },
		frontmatter,
		found.body,
	);
	return { record, reply };
}

/**
 * Record a delivered reply in the issue body: `## Replies` once, then one
 * `### User reply · <at>` entry per delivered text. This is the only trace a
 * reply leaves in git, and it is history, not a queue.
 */
export async function appendReplyHistory(
	root: string,
	id: number,
	text: string,
	at: string,
): Promise<IssueRecord | undefined> {
	const current = await findIssueById(root, id);
	if (!current) return undefined;
	let body = current.body.replace(/\s+$/, "");
	if (!/^## Replies$/m.test(body)) {
		body = body.length > 0 ? `${body}\n\n## Replies` : "## Replies";
	}
	body = `${body}\n\n### User reply · ${at}\n\n${text.trim()}\n`;
	return writeIssueRecord(
		root,
		current,
		{ category: current.category, filename: current.filename, archived: current.archived },
		{ ...current.frontmatter, updated: nowIso() },
		body,
	);
}

/**
 * The turn-end queue: issues this session holds that have a pending reply or a
 * local queue mark. Pending replies come first (oldest first) so a reply is never
 * starved by plain queued work.
 *
 * Only a held issue is queued. An issue becomes a session's work when the user
 * prompts that session to take it, so an unclaimed issue — and one whose claiming
 * session is gone — is in no session's queue until one is prompted to claim it.
 *
 * A committed `stage: up-next` alone is not a queue entry: only a local queue
 * mark counts, so a cloned repo's stage cannot drive this machine's agents. A
 * mark survives while its issue is active and `up-next` or `running` (the work
 * is in flight, so the claiming session keeps looping). It is pruned once the
 * issue is gone, archived, or the agent moved it on: to `needs-you`,
 * `awaiting-deploy`, `deferred`, or no stage at all.
 */
export async function listQueuedIssues(root: string, sessionId: string): Promise<IssueRecord[]> {
	const records = await listIssueRecords(root);
	const byId = new Map(records.map(record => [record.id, record]));
	const queued = await listQueued(root);
	for (const id of queued) {
		const record = byId.get(id);
		const stage = record?.frontmatter.stage;
		if (record && !record.archived && (stage === "up-next" || stage === "running")) continue;
		await setQueued(root, id, false);
		queued.delete(id);
	}

	// Oldest pending reply per issue decides its place in the queue.
	const replyOrder = new Map<number, string>();
	for (const reply of await listReplies(root)) {
		if (!replyOrder.has(reply.id)) replyOrder.set(reply.id, reply.at);
	}
	const candidates: IssueRecord[] = [];
	for (const id of replyOrder.keys()) {
		const record = byId.get(id);
		if (record) candidates.push(record);
	}
	for (const id of queued) {
		const record = byId.get(id);
		if (record && !replyOrder.has(id)) candidates.push(record);
	}

	const held: IssueRecord[] = [];
	for (const record of candidates) {
		// Another session's issue is not this session's work, and a free one waits
		// for a prompt: only the claim makes an issue follow a session. A claim whose
		// session stopped beating is stale — up for grabs, so nobody's work until a
		// prompted session claims it again.
		if ((await claimOwner(root, record.id)) !== sessionId) continue;
		if (await claimIsStale(root, record.id)) continue;
		held.push(record);
	}
	return held.sort((a, b) => {
		const aAt = replyOrder.get(a.id);
		const bAt = replyOrder.get(b.id);
		if (aAt !== undefined && bAt !== undefined) return aAt.localeCompare(bAt) || a.id - b.id;
		if (aAt !== undefined) return -1;
		if (bAt !== undefined) return 1;
		return a.id - b.id;
	});
}

/**
 * Render a markdown listing of issues. Used by both the URL handler and the
 * tool so the listing format is identical regardless of entry point.
 */
export function renderIssueListing(
	summaries: IssueSummary[],
	options: { title: string; emptyText: string; group?: boolean; showArchived?: boolean } = {
		title: "# Issues",
		emptyText: "_No issues._",
	},
): string {
	const lines: string[] = [options.title, ""];
	if (summaries.length === 0) {
		lines.push(options.emptyText);
		return lines.join("\n");
	}

	if (options.group) {
		const grouped = new Map<string, IssueSummary[]>();
		for (const summary of summaries) {
			const key = options.showArchived
				? `${summary.archived ? "archive/" : ""}${summary.category}`
				: summary.category;
			const bucket = grouped.get(key);
			if (bucket) bucket.push(summary);
			else grouped.set(key, [summary]);
		}
		for (const [category, items] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`## ${category} (${items.length})`);
			lines.push("");
			for (const summary of items) {
				lines.push(formatSummaryLine(summary));
			}
			lines.push("");
		}
	} else {
		for (const summary of summaries) {
			lines.push(formatSummaryLine(summary));
		}
	}

	return lines.join("\n").trimEnd();
}

function formatSummaryLine(summary: IssueSummary): string {
	const flags: string[] = [];
	if (summary.severity) flags.push(summary.severity);
	if (summary.status && summary.status !== "open") flags.push(summary.status);
	const tag = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	const archivedSuffix = summary.archived ? " (archived)" : "";
	return `- \`issues://${summary.filename}\` #${summary.id} · ${summary.title}${tag}${archivedSuffix}`;
}
