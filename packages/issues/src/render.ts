/**
 * TUI rendering for the `issues` tool and its subprocess (reviewer) events.
 *
 * Everything renders from `details` — the tool result the host already carries —
 * never from the model-facing text, so the card cannot drift from the store.
 * Collapsed views stay one or two rows; `options.expanded` adds body previews,
 * locations, and the full listing.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	type Badge,
	badge,
	collapsedList,
	errorCard,
	headerLine,
	inline,
	keyValueRows,
	lines,
	severityTone,
	statusTone,
	toolCard,
	toolHeader,
} from "@this-is-my-omp/render";
import type { RepliesDetails } from "./replies";
import type { IssueSeverity, IssueStatus, IssueSummary } from "./store";
import type { IssueFilters, IssuesToolDetails, IssuesToolParams } from "./tool";

const TOOL_LABEL = "Issues";

/** Collapsed listings stop here; the footer counts the rest. */
const LIST_PREVIEW_LIMIT = 8;

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function opOf(args: unknown): IssuesToolParams["op"] | undefined {
	if (!isRecord(args)) return undefined;
	const op = args.op;
	return op === "add" || op === "archive" || op === "unarchive" || op === "list" ? op : undefined;
}

function severityBadge(theme: Theme, severity: IssueSeverity | undefined): string | undefined {
	if (severity === undefined) return undefined;
	return badge(theme, { text: severity, tone: severityTone(severity) });
}

function statusBadge(theme: Theme, status: IssueStatus | undefined): string | undefined {
	if (status === undefined) return undefined;
	return badge(theme, { text: status, tone: statusTone(status) });
}

/** `open → fixed`: the state the file left, then the state it landed in. */
function transitionRow(theme: Theme, details: IssuesToolDetails): string {
	const next = statusBadge(theme, details.status ?? (details.archived ? "fixed" : "open")) ?? "";
	if (details.previousStatus === undefined) return next;
	const arrow = theme.fg("dim", theme.symbol("key.right"));
	return `${statusBadge(theme, details.previousStatus)} ${arrow} ${next}`;
}

/** One listing row: severity, id, title, status, category, URL. */
function listingRow(theme: Theme, summary: IssueSummary): string {
	const severity = severityBadge(theme, summary.severity);
	const status = statusBadge(theme, summary.status);
	const scope = `${summary.category}${summary.archived ? " · archived" : ""}`;
	return [
		severity ?? theme.fg("dim", "[–]"),
		theme.fg("accent", `#${summary.id}`),
		inline(summary.title),
		status ?? "",
		theme.fg("dim", `${scope} · issues://${summary.filename}`),
	]
		.filter(part => part.length > 0)
		.join(" ");
}

/** Severity first (critical → low, unlabelled last), then newest issue first. */
function sortForDisplay(summaries: readonly IssueSummary[]): IssueSummary[] {
	const rank = (summary: IssueSummary): number => (summary.severity ? SEVERITY_RANK[summary.severity] : 4);
	return [...summaries].sort((a, b) => rank(a) - rank(b) || b.id - a.id);
}

function filterMeta(filters: IssueFilters): string[] {
	const meta: string[] = [];
	if (filters.category) meta.push(`category=${filters.category}`);
	if (filters.archived === true) meta.push("archived");
	else if (filters.archived === false) meta.push("active");
	if (filters.severity) meta.push(`severity=${filters.severity}`);
	if (filters.status) meta.push(`status=${filters.status}`);
	if (filters.query) meta.push(`q=${filters.query}`);
	if (filters.limit !== undefined) meta.push(`limit=${filters.limit}`);
	return meta;
}

/** Call row: operation badge, the subject the op names, then its filters. */
export function renderIssuesCall(args: unknown, options: ToolRenderResultOptions, theme: Theme): Component {
	const op = opOf(args);
	const record = isRecord(args) ? args : {};
	let title = "";
	if (op === "add" && typeof record.title === "string" && record.title.trim().length > 0) {
		title = inline(record.title);
	} else if ((op === "archive" || op === "unarchive") && typeof record.id === "number") {
		title = `#${record.id}`;
	} else if (op === "list") {
		title = filterMeta({
			category: typeof record.category === "string" ? record.category : undefined,
			archived: typeof record.archived === "boolean" ? record.archived : undefined,
			severity: typeof record.severity === "string" ? (record.severity as IssueSeverity) : undefined,
			status: typeof record.status === "string" ? (record.status as IssueStatus) : undefined,
			query: typeof record.query === "string" ? record.query : undefined,
		}).join(" ");
	}
	return headerLine(theme, {
		tool: TOOL_LABEL,
		icon: options.isPartial ? "running" : "pending",
		spinnerFrame: options.spinnerFrame,
		title,
		badges: op ? [{ text: op, tone: "accent" }] : [],
	});
}

/** `add` result: the new issue as a card — id, badges, category, location, URL. */
function addCard(theme: Theme, details: IssuesToolDetails, expanded: boolean): Component {
	const badges: Badge[] = [];
	if (details.severity) badges.push({ text: details.severity, tone: severityTone(details.severity) });
	if (details.status) badges.push({ text: details.status, tone: statusTone(details.status) });
	const rows: Array<readonly [string, string]> = [];
	if (details.category) rows.push(["category", details.category]);
	if (details.location) rows.push(["location", details.location]);
	if (details.confidence !== undefined) rows.push(["confidence", details.confidence.toFixed(2)]);
	const body: string[] = [];
	if (expanded && details.bodyPreview) body.push(theme.fg("dim", inline(details.bodyPreview)));
	if (expanded && rows.length > 0) body.push(...keyValueRows(theme, rows));
	if (!expanded) {
		const head = rows.slice(0, 2).map(([key, value]) => `${theme.fg("dim", key)} ${inline(value)}`);
		if (head.length > 0) body.push(head.join(theme.fg("dim", theme.sep.dot)));
	}
	return toolCard(theme, {
		header: {
			tool: TOOL_LABEL,
			icon: "success",
			title: `#${details.id ?? "?"} ${inline(details.title ?? "(untitled)")}`,
			badges,
		},
		body,
		footer: details.url ?? (details.filename ? `issues://${details.filename}` : undefined),
	});
}

/** `archive`/`unarchive` result: where the issue was and where it is now. */
function moveCard(theme: Theme, details: IssuesToolDetails, expanded: boolean): Component {
	const rows: Array<readonly [string, string]> = [];
	if (details.category) rows.push(["category", details.category]);
	if (details.location) rows.push(["location", details.location]);
	const body = [transitionRow(theme, details)];
	if (expanded && rows.length > 0) body.push(...keyValueRows(theme, rows));
	return toolCard(theme, {
		header: {
			tool: TOOL_LABEL,
			icon: details.unchanged === true ? "warning" : "success",
			title: `#${details.id ?? "?"} ${inline(details.title ?? "(untitled)")}`,
			badges: details.archived === true ? [{ text: "archived", tone: "dim" }] : [],
		},
		body,
		footer: details.url ?? (details.filename ? `issues://${details.filename}` : undefined),
	});
}

/** `list` result: severity-sorted rows, collapsed with a counted footer. */
function listView(theme: Theme, details: IssuesToolDetails, expanded: boolean): Component {
	const summaries = sortForDisplay(details.listing ?? []);
	const header = toolHeader(theme, {
		tool: TOOL_LABEL,
		icon: "success",
		title: `${summaries.length} ${summaries.length === 1 ? "issue" : "issues"}`,
		meta: filterMeta(details.filters ?? {}),
	});
	if (summaries.length === 0) return lines([header, `  ${theme.fg("dim", "no matching issues")}`]);
	return lines([
		header,
		...collapsedList(summaries, summary => listingRow(theme, summary), {
			expanded,
			limit: LIST_PREVIEW_LIMIT,
			noun: "issue",
			theme,
		}),
	]);
}

export function renderIssuesResult(
	result: AgentToolResult<IssuesToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	_args?: unknown,
): Component {
	const details = result.details;
	if (result.isError === true || details === undefined || details.error !== undefined) {
		const text = result.content.find(part => part.type === "text");
		const message = details?.error ?? (text?.type === "text" ? text.text : "issues failed");
		return errorCard(theme, TOOL_LABEL, message);
	}
	switch (details.op) {
		case "list":
			return listView(theme, details, options.expanded);
		case "archive":
		case "unarchive":
			return moveCard(theme, details, options.expanded);
		default:
			return addCard(theme, details, options.expanded);
	}
}

/**
 * `registerMessageRenderer` callback for {@link REPLIES_MESSAGE_TYPE}: the
 * reminder that delivered queued board replies on this prompt.
 *
 * Collapsed, one compact row per reply keeps the prompt header small; expanded
 * returns `undefined` so the frame falls back to the reminder text itself, which
 * is where the verbatim reply bodies are.
 */
export function renderRepliesMessage(
	message: { details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const details = message.details as RepliesDetails | undefined;
	if (details === undefined || details.replies.length === 0) return undefined;
	if (options.expanded) return undefined;
	const count = details.replies.length;
	return toolCard(theme, {
		header: {
			tool: "Issue replies",
			icon: "success",
			title: `${count} ${count === 1 ? "reply" : "replies"}`,
		},
		body: collapsedList(details.replies, reply => `${theme.fg("accent", reply.url)} ${inline(reply.title)}`, {
			expanded: false,
			noun: "reply",
			theme,
		}),
	});
}

/**
 * Inline row for an `issues add` event streamed by a subagent.
 *
 * The parent task card only understands `Text`/`Container` subprocess output,
 * so these two renderers build styled strings rather than kit components.
 */
export function renderFiledIssueInline(data: IssuesToolDetails, theme: Theme): Component {
	const severity = severityBadge(theme, data.severity);
	const url = data.url ?? `issues://${data.filename ?? "?"}`;
	return new Text(
		[
			theme.fg("success", theme.status.success),
			severity ?? "",
			theme.fg("accent", `#${data.id ?? "?"}`),
			inline(data.title ?? "(untitled)"),
			theme.fg("dim", url),
		]
			.filter(part => part.length > 0)
			.join(" "),
		0,
		0,
	);
}

/** Accumulated filed issues under a finished task card. */
export function renderFiledIssuesFinal(
	additions: readonly IssuesToolDetails[],
	theme: Theme,
	expanded: boolean,
): Component {
	if (additions.length === 0) return new Text("", 0, 0);
	const summaries = sortForDisplay(
		additions.map(
			(data): IssueSummary => ({
				id: data.id ?? 0,
				category: data.category ?? "",
				title: data.title ?? "(untitled)",
				severity: data.severity,
				status: data.status,
				archived: data.archived === true,
				filename: data.filename ?? "",
			}),
		),
	);
	const header = toolHeader(theme, {
		tool: "Filed issues",
		icon: "success",
		title: `${additions.length} ${additions.length === 1 ? "issue" : "issues"}`,
	});
	const rows = [
		header,
		...collapsedList(summaries, summary => listingRow(theme, summary), {
			expanded,
			limit: 5,
			noun: "issue",
			theme,
		}),
	];
	return new Text(rows.join("\n"), 0, 0);
}
