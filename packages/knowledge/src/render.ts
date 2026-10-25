/**
 * Transcript card for a knowledge pass: progress while it runs and the result
 * when it lands. The pass never enters the model's context — the message that
 * carries this card is stripped from provider requests by the plugin's
 * `context` handler, so only the human sees it.
 */
import type { Component, Theme } from "@oh-my-pi/pi-tui";
import {
	type Badge,
	badge,
	collapsedList,
	errorCard,
	inline,
	sanitize,
	type Tone,
	toolCard,
} from "@this-is-my-omp/render";
import type { KnowledgePassReport } from "./runner";
import type { KnowledgeChange } from "./snapshot";

/** Custom message type carrying {@link KnowledgePassDetails} in `details`. */
export const KNOWLEDGE_PASS_MESSAGE_TYPE = "knowledge-pass";

export interface KnowledgePassDetails {
	title: string;
	status: KnowledgePassReport["status"];
	changes: KnowledgeChange[];
	/** `patch://` URIs for edits that were captured instead of landed. */
	patches: Array<{ uri: string; status: string; error?: string }>;
	commit?: string;
	summary?: string;
	error?: string;
	durationMs: number;
	/** One line per processed session, for `/knowledge build --sessions`. */
	progress?: string[];
	/** Live phase line while the pass runs. */
	phase?: string;
}

function statusTone(status: KnowledgePassDetails["status"]): Tone {
	switch (status) {
		case "completed":
			return "success";
		case "pending":
			return "warning";
		case "failed":
			return "error";
		case "aborted":
			return "dim";
		default:
			return "muted";
	}
}

function statusIcon(status: KnowledgePassDetails["status"]): "success" | "error" | "warning" | "pending" | "running" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "pending":
			return "warning";
		case "aborted":
			return "pending";
		default:
			return "success";
	}
}

function formatDuration(ms: number): string {
	return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function changeRow(theme: Theme, change: KnowledgeChange): string {
	const marker =
		change.kind === "created"
			? theme.fg("success", "+")
			: change.kind === "updated"
				? theme.fg("warning", "~")
				: theme.fg("error", "-");
	const url = theme.fg("accent", `knowledge://${change.path}`);
	return `${marker} ${url} ${theme.fg("dim", change.kind)}`;
}

function countBadges(changes: readonly KnowledgeChange[]): Badge[] {
	const badges: Badge[] = [];
	const created = changes.filter(change => change.kind === "created").length;
	const updated = changes.filter(change => change.kind === "updated").length;
	const deleted = changes.filter(change => change.kind === "deleted").length;
	if (created > 0) badges.push({ text: `${created} new`, tone: "success" });
	if (updated > 0) badges.push({ text: `${updated} updated`, tone: "warning" });
	if (deleted > 0) badges.push({ text: `${deleted} deleted`, tone: "error" });
	return badges;
}

/** Body rows for the card, in reading order: changes, patches, progress, notes. */
function bodyRows(theme: Theme, details: KnowledgePassDetails, expanded: boolean): string[] {
	const rows: string[] = [];
	if (details.phase !== undefined) rows.push(theme.fg("muted", inline(details.phase)));
	if (details.changes.length > 0) {
		rows.push(
			...collapsedList(details.changes, change => changeRow(theme, change), {
				expanded,
				limit: 8,
				noun: "note",
				theme,
			}),
		);
	}
	if (details.patches.length > 0) {
		rows.push(
			...collapsedList(
				details.patches,
				patch => {
					const tone =
						patch.status === "applied" ? "success" : patch.status === "conflicted" ? "error" : "warning";
					const error = patch.error ? ` ${theme.fg("dim", sanitize(patch.error))}` : "";
					return `${theme.fg("accent", patch.uri)} ${badge(theme, { text: patch.status, tone })}${error}`;
				},
				{ expanded, limit: 4, noun: "patch", theme },
			),
		);
	}
	if (expanded && details.progress && details.progress.length > 0) {
		for (const line of details.progress) rows.push(theme.fg("dim", sanitize(line)));
	}
	if (details.error) rows.push(theme.fg("error", sanitize(details.error)));
	if (expanded && details.summary) rows.push(theme.fg("muted", sanitize(details.summary)));
	return rows;
}

function footerText(theme: Theme, details: KnowledgePassDetails): string | undefined {
	const facts: string[] = [formatDuration(details.durationMs)];
	if (details.commit) facts.push(`commit ${details.commit}`);
	return facts.length > 0 ? theme.fg("dim", facts.join(" · ")) : undefined;
}

/**
 * `registerMessageRenderer` callback for {@link KNOWLEDGE_PASS_MESSAGE_TYPE}.
 * The message content stays a one-line summary so text-only modes stay useful.
 */
export function renderKnowledgePassMessage(
	message: { details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const details = message.details as KnowledgePassDetails | undefined;
	if (!details) return undefined;
	if (details.status === "failed" && details.error) {
		return errorCard(theme, details.title, details.error);
	}
	return toolCard(theme, {
		header: {
			tool: "Knowledge",
			icon: statusIcon(details.status),
			title: details.title,
			badges: [{ text: details.status, tone: statusTone(details.status) }, ...countBadges(details.changes)],
		},
		body: bodyRows(theme, details, options.expanded),
		footer: footerText(theme, details),
	});
}

/** Convert a finished pass into message details. */
export function toDetails(report: KnowledgePassReport, extra?: Partial<KnowledgePassDetails>): KnowledgePassDetails {
	return {
		title: report.title,
		status: report.status,
		changes: report.changes,
		patches: report.patches.map(patch => ({ uri: patch.uri, status: patch.status, error: patch.error })),
		commit: report.commit,
		summary: report.summary,
		error: report.error,
		durationMs: report.durationMs,
		...extra,
	};
}
