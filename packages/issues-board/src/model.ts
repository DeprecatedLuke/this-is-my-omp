/**
 * Board model: which state an issue is in, which list group it belongs to, how
 * rows sort, what a state key writes to the store, and where a `report://`
 * value points.
 *
 * Everything here but the loaders is pure — the TUI in `board.ts` and the JSON
 * API in `api.ts` own their front ends, the store in `omp-issues` owns the
 * files. Keeping the mapping in one place means the states, the move semantics
 * and the grouping cannot drift.
 */

import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { getPluginsLockfile, getProjectPluginOverridesPath } from "@oh-my-pi/pi-utils";
import { claimIsStale, claimOwner, listReplies, type PendingReply, type SeenState } from "omp-issues/src/inbox";
import type { IssueMove, IssueRecord, IssueSeverity, IssueStatus } from "omp-issues/src/store";

/** States the `1`-`7` keys set, in key order. `done` archives with a terminal status. */
export type BoardStateId = "needs-you" | "up-next" | "open" | "running" | "awaiting-deploy" | "deferred" | "done";

export interface BoardState {
	id: BoardStateId;
	title: string;
}

/** States in key order: `1` is Needs you, `7` is Done. */
export const BOARD_STATES: readonly BoardState[] = [
	{ id: "needs-you", title: "Needs you" },
	{ id: "up-next", title: "Up next" },
	{ id: "open", title: "Open" },
	{ id: "running", title: "Running" },
	{ id: "awaiting-deploy", title: "Awaiting deploy" },
	{ id: "deferred", title: "Deferred" },
	{ id: "done", title: "Done" },
];

/** Statuses that close an issue in Done. */
export type DoneStatus = Extract<IssueStatus, "fixed" | "wontfix" | "duplicate">;

/** Done choices, in prompt order. */
export const DONE_STATUSES: readonly DoneStatus[] = ["fixed", "wontfix", "duplicate"];

/** How far back the Done group looks unless it is showing every archived issue. */
export const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** List groups, top to bottom. */
export type ListGroupId = "active" | "finished" | "deploy" | "done";

export interface ListGroup {
	id: ListGroupId;
	title: string;
}

/** Groups in display order: unreviewed results first, then live work, shipped-but-undeployed work, then history. */
export const LIST_GROUPS: readonly ListGroup[] = [
	{ id: "finished", title: "Finished" },
	{ id: "active", title: "Active" },
	{ id: "deploy", title: "Awaiting deploy" },
	{ id: "done", title: "Done" },
];

/** One group with its rows, sorted for display. */
export interface ListGroupView {
	group: ListGroup;
	records: IssueRecord[];
}

/** State of an issue: archived ones are Done, else the stage, else in-progress → Running, else Open. */
export function stateOf(record: IssueRecord): BoardStateId {
	if (record.archived) return "done";
	const stage = record.frontmatter.stage;
	if (
		stage === "needs-you" ||
		stage === "up-next" ||
		stage === "running" ||
		stage === "awaiting-deploy" ||
		stage === "deferred"
	) {
		return stage;
	}
	return record.frontmatter.status === "in-progress" ? "running" : "open";
}

/** Title of a state id. */
export function stateTitle(state: BoardStateId): string {
	return BOARD_STATES.find(entry => entry.id === state)?.title ?? state;
}

/** Chip text: the state, and for an archived issue its group plus the resolution. */
export function stateLabel(record: IssueRecord, group: ListGroupId): string {
	if (group === "active" || group === "deploy") return stateTitle(stateOf(record));
	const status = record.frontmatter.status;
	const closed = status === "fixed" || status === "wontfix" || status === "duplicate";
	const base = group === "finished" ? "Finished" : "Done";
	return closed ? `${base} · ${status}` : base;
}

/** Colour of a state, shared by the row chips and the footer's state keys. */
export function stateIdTone(state: BoardStateId): ThemeColor {
	switch (state) {
		case "needs-you":
			return "error";
		case "up-next":
			return "accent";
		case "running":
			return "success";
		case "awaiting-deploy":
			return "syntaxFunction";
		case "deferred":
			return "dim";
		case "done":
			return "toolDiffAdded";
		default:
			return "syntaxType";
	}
}

/** Chip colour: every state its own hue; attention states are warm, settled ones recede. */
export function stateTone(record: IssueRecord, group: ListGroupId): ThemeColor {
	if (group === "finished") return "warning";
	if (group === "done") return record.frontmatter.status === "fixed" ? "toolDiffAdded" : "muted";
	return stateIdTone(stateOf(record));
}

/**
 * Nerd Font glyphs (Octicons, `nf-oct-*`; GitHub's issue icons where one fits).
 * The TUI and the Tern block both draw these, so a terminal or block font
 * without Nerd Font glyphs shows boxes.
 */
export const GLYPHS = {
	finished: "\uf48d", // nf-oct-inbox
	fixed: "\uf41d", // nf-oct-issue_closed
	wontfix: "\uf517", // nf-oct-skip
	duplicate: "\uf4c4", // nf-oct-duplicate
	needsYou: "\uf421", // nf-oct-alert
	upNext: "\uf500", // nf-oct-play
	running: "\uf46a", // nf-oct-sync
	awaitingDeploy: "\uf427", // nf-oct-rocket
	deferred: "\uf43a", // nf-oct-clock
	open: "\uf41b", // nf-oct-issue_opened
	claim: "\uf4e3", // nf-oct-hourglass
} as const;

/** State glyph shown before the chip, in the chip's colour. */
export function stateGlyph(record: IssueRecord, group: ListGroupId): string {
	if (group === "finished") return GLYPHS.finished;
	if (group === "done") {
		switch (record.frontmatter.status) {
			case "fixed":
				return GLYPHS.fixed;
			case "duplicate":
				return GLYPHS.duplicate;
			default:
				return GLYPHS.wontfix;
		}
	}
	switch (stateOf(record)) {
		case "needs-you":
			return GLYPHS.needsYou;
		case "up-next":
			return GLYPHS.upNext;
		case "running":
			return GLYPHS.running;
		case "awaiting-deploy":
			return GLYPHS.awaitingDeploy;
		case "deferred":
			return GLYPHS.deferred;
		default:
			return GLYPHS.open;
	}
}

/** Group header colour: Active and Finished pull the eye, Awaiting deploy matches its chip, Done recedes. */
export function groupTone(group: ListGroupId): ThemeColor {
	switch (group) {
		case "active":
			return "accent";
		case "finished":
			return "warning";
		case "deploy":
			return "syntaxFunction";
		default:
			return "success";
	}
}

const CATEGORY_TONES: readonly ThemeColor[] = [
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxString",
	"syntaxType",
	"syntaxNumber",
	"mdLink",
	"mdHeading",
	"syntaxVariable",
];

/** A stable colour per category name, so the same category reads the same everywhere. */
export function categoryTone(category: string): ThemeColor {
	let hash = 0;
	for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
	return CATEGORY_TONES[hash % CATEGORY_TONES.length]!;
}

/**
 * The store move a state key means. Done needs the terminal status and closing
 * remarks the prompts collected; moving an archived issue to any active state
 * also reopens it.
 */
export function moveFor(
	state: BoardStateId,
	record: IssueRecord,
	doneStatus?: DoneStatus,
	remarks?: string,
): IssueMove {
	if (state === "done") {
		if (!doneStatus) throw new Error(`Moving #${record.id} to Done needs a terminal status`);
		return { stage: null, status: doneStatus, reason: remarks };
	}
	const target: IssueMove = state === "open" ? { stage: null, status: "open" } : { stage: state };
	return record.archived ? { ...target, status: "open" } : target;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Sort weight of a severity; unset or unknown ranks below `low`. */
export function severityRank(record: IssueRecord): number {
	const severity = record.frontmatter.severity;
	return severity === undefined ? 0 : (SEVERITY_RANK[severity] ?? 0);
}

/** `updated` as epoch ms; unparsable or missing dates sort last. */
export function updatedMs(record: IssueRecord): number {
	const updated = record.frontmatter.updated;
	const parsed = updated === undefined ? Number.NaN : Date.parse(updated);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Most recently updated first, then id: the order of every group. */
export function compareNewest(a: IssueRecord, b: IssueRecord): number {
	const byUpdated = updatedMs(b) - updatedMs(a);
	return byUpdated !== 0 ? byUpdated : b.id - a.id;
}

/** Case-insensitive substring match over title, category and body. */
export function matchesFilter(record: IssueRecord, needle: string): boolean {
	const query = needle.trim().toLowerCase();
	if (query === "") return true;
	const title = record.frontmatter.title ?? "";
	return (
		title.toLowerCase().includes(query) ||
		record.category.toLowerCase().includes(query) ||
		record.body.toLowerCase().includes(query)
	);
}

/** Compact age of `updated`: `now`, `5m`, `3h`, `2d`, `6w`. */
export function relativeAge(record: IssueRecord, now: number = Date.now()): string {
	const updated = updatedMs(record);
	if (updated === 0) return "—";
	const seconds = Math.max(0, Math.round((now - updated) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d`;
	const weeks = Math.round(days / 7);
	if (weeks < 52) return `${weeks}w`;
	return `${Math.round(weeks / 52)}y`;
}

/**
 * Machine-local "the user has looked at this" state, from the issues inbox: the
 * global watermark plus the per-issue stamp the user last opened.
 */
export type { SeenState };

export const EMPTY_SEEN: SeenState = { watermark: "", seen: new Map() };

/** Epoch ms of an ISO stamp; an absent or unparsable one counts as never. */
function stampMs(stamp: string | undefined): number {
	const parsed = stamp === undefined ? Number.NaN : Date.parse(stamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** True when an archived issue changed after the user last looked at it. */
export function isUnseen(record: IssueRecord, seen: SeenState): boolean {
	if (!record.archived) return false;
	const updated = updatedMs(record);
	if (updated === 0) return false;
	const mark = seen.seen.get(record.id);
	return updated > Math.max(stampMs(seen.watermark), mark === undefined ? 0 : stampMs(mark));
}

/** Group an issue belongs in before the filter and the Done window apply. */
export function groupOf(record: IssueRecord, seen: SeenState): ListGroupId {
	if (!record.archived) return stateOf(record) === "awaiting-deploy" ? "deploy" : "active";
	return isUnseen(record, seen) ? "finished" : "done";
}

export interface BuildListOptions {
	/** Filter text; empty shows everything. */
	filter?: string;
	/** Show every archived issue in Done instead of just the last week's. */
	showAllDone?: boolean;
	/** What the user has already seen; empty puts every archived issue in Finished. */
	seen?: SeenState;
	/** Clock for the Done window (tests). */
	now?: number;
}

/**
 * Group records into Finished (archived and not yet seen), Active (every
 * non-archived issue not awaiting deploy), Awaiting deploy (`stage:
 * awaiting-deploy`) and Done (archived and seen), each newest `updated`
 * first. Empty groups are dropped, so the list never shows a header with
 * nothing under it.
 */
export function buildList(records: readonly IssueRecord[], options: BuildListOptions = {}): ListGroupView[] {
	const filter = options.filter ?? "";
	const seen = options.seen ?? EMPTY_SEEN;
	const now = options.now ?? Date.now();
	const rows = new Map<ListGroupId, IssueRecord[]>(LIST_GROUPS.map(group => [group.id, []]));
	for (const record of records) {
		if (!matchesFilter(record, filter)) continue;
		const group = groupOf(record, seen);
		if (group === "done" && options.showAllDone !== true && now - updatedMs(record) > DONE_WINDOW_MS) continue;
		rows.get(group)?.push(record);
	}
	return LIST_GROUPS.map(group => ({
		group,
		records: (rows.get(group.id) ?? []).sort(compareNewest),
	})).filter(view => view.records.length > 0);
}

/**
 * The machine-local side of the board, read from the user's issues inbox
 * (never from the git-tracked issue files): replies queued for the next agent
 * prompt, and the omp session each issue is handed to.
 */
export interface BoardInbox {
	/** Pending replies per issue id, oldest first. */
	replies: ReadonlyMap<number, readonly PendingReply[]>;
	/** Claiming omp session id per issue id; only live claims (a dead session's claim is free). */
	claims: ReadonlyMap<number, string>;
}

export const EMPTY_INBOX: BoardInbox = { replies: new Map(), claims: new Map() };

/** Session-id prefix a row and the footer show; the detail view has the whole id. */
export const CLAIM_SHOWN_CHARS = 6;

/**
 * Full id of the session holding issue `id`, or undefined when no session holds
 * it or the holder stopped heartbeating: a dead session's claim is free, so the
 * board never reports an issue as held by a session that is gone.
 */
export async function liveHolder(root: string, id: number): Promise<string | undefined> {
	const holder = await claimOwner(root, id);
	if (holder === undefined || (await claimIsStale(root, id))) return undefined;
	return holder;
}

/** The prefix of a session id the board shows in rows and status lines. */
export function shortSession(sessionId: string): string {
	return sessionId.slice(0, CLAIM_SHOWN_CHARS);
}

/**
 * Read the inbox state for `records` from the checkout's issues inbox. A claim
 * whose session stopped heartbeating is free to the plugin, so it is left out
 * here too: the board never shows an issue as held by a session that is gone.
 */
export async function loadInbox(root: string, records: readonly IssueRecord[]): Promise<BoardInbox> {
	const [pending, holders] = await Promise.all([
		listReplies(root),
		Promise.all(records.map(async record => [record.id, await liveHolder(root, record.id)] as const)),
	]);
	const replies = new Map<number, PendingReply[]>();
	for (const reply of pending) {
		const list = replies.get(reply.id);
		if (list) list.push(reply);
		else replies.set(reply.id, [reply]);
	}
	const claims = new Map<number, string>();
	for (const [id, holder] of holders) if (holder !== undefined) claims.set(id, holder);
	return { replies, claims };
}

/** Replies the user queued for issue `id` that no agent has taken yet, oldest first. */
export function pendingReplies(inbox: BoardInbox, id: number): readonly PendingReply[] {
	return inbox.replies.get(id) ?? [];
}

/** omp session id of the agent issue `id` is handed to, if it is still claimed. */
export function claimedBy(inbox: BoardInbox, id: number): string | undefined {
	return inbox.claims.get(id);
}

/** Plugin that serves report links. */
export const REPORTS_PLUGIN = "agent-reports";

/** `.settings[plugin]` of a plugin config file, or `{}` when it is absent or unreadable. */
async function readPluginSettingsFile(file: string, plugin: string): Promise<Record<string, unknown>> {
	try {
		const settings = (await Bun.file(file).json())?.settings?.[plugin];
		return typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Settings of `plugin`: its entries in omp's plugin lockfile, overridden by the
 * checkout's `.omp/plugin-overrides.json`.
 *
 * This reads the two files omp's own `getPluginSettings` merges instead of
 * importing it, because that module pulls in omp's whole config stack (some
 * 250 ms of module work) and the board is a command that starts per keypress.
 * The trade-off is that overrides in `.claude`/`.codex`/`.gemini` project dirs
 * are not consulted; an omp plugin's settings live in `.omp`.
 */
export async function loadPluginSettings(plugin: string, root: string): Promise<Record<string, unknown>> {
	const [global, project] = await Promise.all([
		readPluginSettingsFile(getPluginsLockfile(), plugin),
		readPluginSettingsFile(getProjectPluginOverridesPath(root), plugin),
	]);
	return { ...global, ...project };
}

/**
 * Base url of the report site from the `agent-reports` plugin settings, or
 * undefined when the user has not configured one.
 */
export async function loadReportBaseUrl(root: string): Promise<string | undefined> {
	const settings = await loadPluginSettings(REPORTS_PLUGIN, root);
	const url = typeof settings.url === "string" ? settings.url.trim().replace(/\/+$/, "") : "";
	return url === "" ? undefined : url;
}

/** The `report:` value an issue carries, if any. */
export function reportValue(record: IssueRecord): string | undefined {
	const value = record.frontmatter.report;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Where a `report://<project>/<slug>` value points: the site's `/r/…` page when
 * a base url is configured, else the raw value the issue carries.
 */
export function reportUrl(value: string, baseUrl: string | undefined): string {
	const raw = value.trim();
	if (baseUrl === undefined) return raw;
	const target = raw.replace(/^report:\/\//, "").replace(/^\/+/, "");
	return target === "" ? raw : `${baseUrl}/r/${target}`;
}
