/**
 * `omp-board api`: the board as JSON, for front ends that draw it themselves
 * (the Tern block) instead of running the TUI in a pane.
 *
 * One verb per process, one JSON object on stdout, exit 0. Any failure is exit 1
 * with `{"error": "<message>"}`, so a caller never has to parse a stack trace.
 * The import graph here is the store, the inbox and `model.ts` — no TUI module,
 * no theme, no omp settings — because a caller runs this per keypress.
 *
 *   snapshot [--filter TEXT] [--all-done]     the whole board
 *   wait --since FP [--timeout-ms N]          block until the board changes
 *   detail ID                                 one issue, its replies and body
 *   seen ID                                   mark a Finished issue as looked at
 *   move ID STATE [--status fixed|…]          the `1`-`7` keys
 *   reply ID                                  queue a reply typed on stdin
 *   report-url VALUE                          the site URL of a report:// value
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { inboxDir, listReplies, loadSeen } from "omp-issues/src/inbox";
import {
	findIssueById,
	type IssueRecord,
	type IssueSeverity,
	type IssueStage,
	type IssueStatus,
	listIssueRecords,
} from "omp-issues/src/store";
import { markIssueSeen, moveIssueTo, moveMessage, replyToBoardIssue } from "./actions";
import { findCheckoutRoot } from "./cli";
import {
	BOARD_STATES,
	type BoardStateId,
	buildList,
	claimedBy,
	DONE_STATUSES,
	type DoneStatus,
	groupOf,
	type ListGroupId,
	liveHolder,
	loadInbox,
	loadReportBaseUrl,
	pendingReplies,
	relativeAge,
	reportUrl,
	reportValue,
	shortSession,
	stateGlyph,
	stateLabel,
	stateOf,
} from "./model";
import { type IssuesWatcher, watchIssues } from "./watch";

/** Default of `wait --timeout-ms`. */
const DEFAULT_WAIT_MS = 25_000;
/** How often `wait` re-reads even without a filesystem event, so stale claims are noticed. */
const WAIT_RECHECK_MS = 5_000;
/** Inbox subdirectories whose entries change the board. */
const INBOX_DIRS = ["replies", "queued", "claims", "seen"] as const;

/** One row of the board, as a front end draws it. */
export interface ApiRow {
	id: number;
	title: string;
	category: string;
	severity: IssueSeverity | null;
	group: ListGroupId;
	state: BoardStateId;
	label: string;
	glyph: string;
	status: IssueStatus | null;
	stage: IssueStage | null;
	/** What the issue waits on: the user's ask on a `needs-you` issue, the exact
	 *  roll on an `awaiting-deploy` one. */
	needs: string | null;
	archived: boolean;
	updated: string | null;
	age: string;
	replies: number;
	claim: string | null;
	report: string | null;
	file: string;
}

export interface ApiGroup {
	id: ListGroupId;
	title: string;
	rows: ApiRow[];
}

export interface ApiSnapshot {
	root: string;
	repo: string;
	fingerprint: string;
	filter: string;
	allDone: boolean;
	counts: Record<ListGroupId, number>;
	groups: ApiGroup[];
	states: { key: string; id: BoardStateId; title: string }[];
	doneStatuses: DoneStatus[];
}

export interface ApiDetail {
	row: ApiRow;
	location: string[] | null;
	created: string | null;
	claimFull: string | null;
	reportValue: string | null;
	replies: { at: string; text: string }[];
	body: string;
}

export interface ApiOptions {
	verb: string;
	positional: string[];
	root: string;
	filter: string;
	allDone: boolean;
	since?: string;
	timeoutMs: number;
	status?: string;
}

/** Thrown for a malformed command line; reported as the `error` object. */
class ApiUsageError extends Error {}

function parseId(raw: string | undefined, what: string): number {
	const id = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	if (!Number.isFinite(id) || id <= 0 || String(id) !== raw?.trim()) {
		throw new ApiUsageError(`${what} needs a positive issue id, got '${raw ?? ""}'`);
	}
	return id;
}

/** Split `--flag value` / `--flag=value` off the argument list. */
function flagValue(argv: readonly string[], index: number, name: string): { value: string; next: number } {
	const arg = argv[index]!;
	if (arg === name) {
		const value = argv[index + 1];
		if (value === undefined) throw new ApiUsageError(`${name} needs a value`);
		return { value, next: index + 1 };
	}
	return { value: arg.slice(name.length + 1), next: index };
}

/** Parse `api <verb> [args] [--root PATH] [flags]`. */
export function parseApiArgs(argv: readonly string[]): ApiOptions {
	const options: ApiOptions = {
		verb: "",
		positional: [],
		root: process.cwd(),
		filter: "",
		allDone: false,
		timeoutMs: DEFAULT_WAIT_MS,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--root" || arg.startsWith("--root=")) {
			const flag = flagValue(argv, index, "--root");
			options.root = flag.value;
			index = flag.next;
			continue;
		}
		if (arg === "--filter" || arg.startsWith("--filter=")) {
			const flag = flagValue(argv, index, "--filter");
			options.filter = flag.value;
			index = flag.next;
			continue;
		}
		if (arg === "--all-done") {
			options.allDone = true;
			continue;
		}
		if (arg === "--since" || arg.startsWith("--since=")) {
			const flag = flagValue(argv, index, "--since");
			options.since = flag.value;
			index = flag.next;
			continue;
		}
		if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
			const flag = flagValue(argv, index, "--timeout-ms");
			const value = Number.parseInt(flag.value, 10);
			if (!Number.isFinite(value) || value < 0) {
				throw new ApiUsageError(`--timeout-ms needs a non-negative number, got '${flag.value}'`);
			}
			options.timeoutMs = value;
			index = flag.next;
			continue;
		}
		if (arg === "--status" || arg.startsWith("--status=")) {
			const flag = flagValue(argv, index, "--status");
			options.status = flag.value;
			index = flag.next;
			continue;
		}
		if (arg.startsWith("-")) throw new ApiUsageError(`unknown option '${arg}'`);
		options.positional.push(arg);
	}
	const verb = options.positional.shift();
	if (verb === undefined) throw new ApiUsageError("api needs a verb");
	options.verb = verb;
	return options;
}

/** Reject extra positionals, so a typo cannot silently do nothing. */
function requirePositionals(options: ApiOptions, count: number): void {
	if (options.positional.length > count) {
		throw new ApiUsageError(`${options.verb} takes ${count} argument${count === 1 ? "" : "s"}`);
	}
}

/** Every file below `dir` as `relative/path:mtime:size`, sorted; missing dirs read as empty. */
async function fileStamps(dir: string, out: string[], prefix = ""): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		// Dot-entries are in-flight temp files, taken replies and the inbox
		// watermark: none of them is a pending instruction the board shows.
		if (entry.name.startsWith(".")) continue;
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await fileStamps(full, out, relative);
			continue;
		}
		const stat = await fsp.stat(full).catch(() => undefined);
		if (stat === undefined) continue;
		out.push(`${relative}:${stat.mtimeMs}:${stat.size}`);
	}
}

/**
 * What the board would show, as one hash: every issue file (archived included),
 * the inbox's replies, queue marks, claims and seen stamps, and which claims are
 * still live — a claim goes stale on the clock alone, with no write to watch.
 */
export async function fingerprintOf(root: string): Promise<string> {
	const stamps: string[] = [];
	await fileStamps(path.join(root, ".omp", "issues"), stamps);
	const inbox = inboxDir(root);
	for (const name of INBOX_DIRS) await fileStamps(path.join(inbox, name), stamps);
	const claims = await fsp.readdir(path.join(inbox, "claims")).catch(() => [] as string[]);
	for (const name of claims.sort()) {
		if (!/^\d+$/.test(name)) continue;
		const holder = await liveHolder(root, Number(name));
		stamps.push(`claim:${name}:${holder ?? "-"}`);
	}
	return crypto.createHash("sha256").update(stamps.join("\n")).digest("hex");
}

/** One row: the issue, the group it is listed under, and its machine-local state. */
function rowFor(
	record: IssueRecord,
	group: ListGroupId,
	claim: string | undefined,
	replies: number,
	reportBase: string | undefined,
): ApiRow {
	const report = reportValue(record);
	return {
		id: record.id,
		title: record.frontmatter.title ?? "",
		category: record.category,
		severity: record.frontmatter.severity ?? null,
		group,
		state: stateOf(record),
		label: stateLabel(record, group),
		glyph: stateGlyph(record, group),
		status: record.frontmatter.status ?? null,
		stage: record.frontmatter.stage ?? null,
		needs: record.frontmatter.needs ?? null,
		archived: record.archived,
		updated: record.frontmatter.updated ?? null,
		age: relativeAge(record),
		replies,
		claim: claim === undefined ? null : shortSession(claim),
		report: report === undefined ? null : reportUrl(report, reportBase),
		file: record.filePath,
	};
}

/** The board as the TUI header and list show it. */
export async function snapshotOf(root: string, options: ApiOptions): Promise<ApiSnapshot> {
	const records = await listIssueRecords(root);
	const [inbox, seen, reportBase] = await Promise.all([
		loadInbox(root, records),
		loadSeen(root),
		loadReportBaseUrl(root),
	]);
	const counts: Record<ListGroupId, number> = { finished: 0, active: 0, deploy: 0, done: 0 };
	const groups: ApiGroup[] = [];
	for (const view of buildList(records, { filter: options.filter, showAllDone: options.allDone, seen })) {
		counts[view.group.id] = view.records.length;
		groups.push({
			id: view.group.id,
			title: view.group.title,
			rows: view.records.map(record =>
				rowFor(
					record,
					view.group.id,
					claimedBy(inbox, record.id),
					pendingReplies(inbox, record.id).length,
					reportBase,
				),
			),
		});
	}
	return {
		root,
		repo: path.basename(root),
		fingerprint: await fingerprintOf(root),
		filter: options.filter,
		allDone: options.allDone,
		counts,
		groups,
		states: BOARD_STATES.map((state, index) => ({ key: String(index + 1), id: state.id, title: state.title })),
		doneStatuses: [...DONE_STATUSES],
	};
}

/** One issue with what the detail view shows; it does not mark the issue seen. */
export async function detailOf(root: string, id: number): Promise<ApiDetail> {
	const record = await findIssueById(root, id);
	if (record === undefined) throw new Error(`Issue #${id} not found.`);
	const [seen, claimFull, replies, reportBase] = await Promise.all([
		loadSeen(root),
		liveHolder(root, id),
		listReplies(root),
		loadReportBaseUrl(root),
	]);
	const pending = replies.filter(reply => reply.id === id);
	return {
		row: rowFor(record, groupOf(record, seen), claimFull, pending.length, reportBase),
		location: record.frontmatter.location ?? null,
		created: record.frontmatter.created ?? null,
		claimFull: claimFull ?? null,
		reportValue: reportValue(record) ?? null,
		replies: pending.map(reply => ({ at: reply.at, text: reply.text })),
		body: record.body,
	};
}

/** Resolve `--root` to a checkout root. */
function resolveRoot(raw: string): string {
	const start = path.resolve(raw);
	const root = findCheckoutRoot(start);
	if (root === undefined) throw new Error(`no .omp/issues found at or above ${start}`);
	return root;
}

/**
 * `report-url VALUE`: the site URL a `report://<project>/<slug>` value points
 * at. Unlike every other verb this needs no tracker, so it takes the nearest
 * checkout as a project-settings scope and falls back to the path itself.
 */
async function reportUrlVerb(options: ApiOptions): Promise<{ url: string }> {
	requirePositionals(options, 1);
	const value = options.positional[0];
	if (value === undefined || value.trim() === "") throw new ApiUsageError("report-url needs a report value");
	const start = path.resolve(options.root);
	const base = await loadReportBaseUrl(findCheckoutRoot(start) ?? start);
	if (base === undefined) {
		throw new Error(
			"no report site: set the agent-reports url with 'omp plugin config set agent-reports url https://…'",
		);
	}
	return { url: reportUrl(value, base) };
}

/** `move ID STATE`: the store write of a `1`-`7` keypress. */
async function moveVerb(root: string, options: ApiOptions): Promise<{ message: string }> {
	const id = parseId(options.positional[0], "move");
	requirePositionals(options, 2);
	const state = options.positional[1];
	const known = BOARD_STATES.find(entry => entry.id === state);
	if (known === undefined) {
		throw new ApiUsageError(`unknown state '${state ?? ""}'; use one of ${BOARD_STATES.map(s => s.id).join(", ")}`);
	}
	const doneStatus = options.status;
	if (known.id === "done" && doneStatus === undefined) {
		throw new ApiUsageError(`moving #${id} to Done needs --status ${DONE_STATUSES.join("|")}`);
	}
	if (doneStatus !== undefined && !DONE_STATUSES.includes(doneStatus as DoneStatus)) {
		throw new ApiUsageError(`--status must be one of ${DONE_STATUSES.join(", ")}, got '${doneStatus}'`);
	}
	if (doneStatus !== undefined && known.id !== "done") {
		throw new ApiUsageError("--status only applies to Done");
	}
	const record = await findIssueById(root, id);
	if (record === undefined) throw new Error(`Issue #${id} not found.`);
	// Already there: the TUI's key is a no-op, so the store is left alone and the
	// issue keeps its `updated`.
	if (!record.archived && stateOf(record) === known.id) {
		const holder = known.id === "done" ? undefined : await liveHolder(root, id);
		return { message: moveMessage(id, known.id, holder) };
	}
	const { message } = await moveIssueTo(root, record, known.id, doneStatus as DoneStatus | undefined);
	return { message };
}

/** `reply ID` with the text on stdin. */
async function replyVerb(root: string, options: ApiOptions): Promise<{ message: string }> {
	const id = parseId(options.positional[0], "reply");
	requirePositionals(options, 1);
	const text = await Bun.stdin.text();
	const { message } = await replyToBoardIssue(root, id, text);
	return { message };
}

/** `seen ID`: record that the user looked at the issue as of its current `updated`. */
async function seenVerb(root: string, options: ApiOptions): Promise<{ message: string }> {
	const id = parseId(options.positional[0], "seen");
	requirePositionals(options, 1);
	const record = await findIssueById(root, id);
	if (record === undefined) throw new Error(`Issue #${id} not found.`);
	await markIssueSeen(root, record);
	return { message: `#${id} seen` };
}

/**
 * `wait --since FP`: resolve once the fingerprint moves off FP, with the full
 * snapshot; the timeout resolves `{"unchanged": true}`. Filesystem events make
 * the common case immediate, the re-check catches a claim that went stale and
 * the timeout catches the rest.
 */
async function waitVerb(
	root: string,
	options: ApiOptions,
): Promise<ApiSnapshot | { unchanged: true; fingerprint: string }> {
	if (options.since === undefined) throw new ApiUsageError("wait needs --since <fingerprint>");
	const since = options.since;
	const deadline = Date.now() + options.timeoutMs;
	// The watermark is written on first use and changes which archived issues
	// count as seen, so it exists before the first fingerprint is taken.
	await loadSeen(root);
	fs.mkdirSync(inboxDir(root), { recursive: true });
	let dirty = false;
	let wake: (() => void) | undefined;
	const mark = (): void => {
		dirty = true;
		wake?.();
	};
	const watchers: IssuesWatcher[] = [
		watchIssues(path.join(root, ".omp", "issues"), mark),
		watchIssues(inboxDir(root), mark),
	];
	const recheck = setInterval(mark, WAIT_RECHECK_MS);
	try {
		for (;;) {
			dirty = false;
			const fingerprint = await fingerprintOf(root);
			if (fingerprint !== since) return await snapshotOf(root, options);
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { unchanged: true, fingerprint };
			if (!dirty) {
				const signal = Promise.withResolvers<void>();
				const timer = setTimeout(() => {
					wake = undefined;
					signal.resolve();
				}, remaining);
				wake = () => {
					clearTimeout(timer);
					wake = undefined;
					signal.resolve();
				};
				await signal.promise;
			}
		}
	} finally {
		clearInterval(recheck);
		for (const watcher of watchers) watcher.close();
	}
}

/** Run one verb and print its JSON object; returns the process exit code. */
export async function runApi(argv: readonly string[]): Promise<number> {
	let result: unknown;
	let code = 0;
	try {
		const options = parseApiArgs(argv);
		// `report-url` resolves a setting, not a tracker, so it works outside a
		// checkout; every other verb needs one.
		if (options.verb === "report-url") {
			result = await reportUrlVerb(options);
		} else {
			const root = resolveRoot(options.root);
			switch (options.verb) {
				case "snapshot":
					requirePositionals(options, 0);
					result = await snapshotOf(root, options);
					break;
				case "wait":
					requirePositionals(options, 0);
					result = await waitVerb(root, options);
					break;
				case "detail":
					result = await detailOf(root, parseId(options.positional[0], "detail"));
					break;
				case "seen":
					result = await seenVerb(root, options);
					break;
				case "move":
					result = await moveVerb(root, options);
					break;
				case "reply":
					result = await replyVerb(root, options);
					break;
				default:
					throw new ApiUsageError(`unknown verb '${options.verb}'`);
			}
		}
	} catch (error) {
		code = 1;
		result = { error: error instanceof Error ? error.message : String(error) };
	}
	await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
	return code;
}
