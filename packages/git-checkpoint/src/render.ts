/**
 * TUI rendering for `git_checkpoint`: a stage badge on the call row, a repo list
 * for the listing stage, and per-repo outcome rows with status badges for the
 * commit stage. Everything is driven by `details`, so partial or failed results
 * still render from whatever the stage produced.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import {
	type Badge,
	collapsedList,
	errorCard,
	headerLine,
	pathLabel,
	sanitize,
	statusTone,
	type Theme,
	toolCard,
} from "@this-is-my-omp/render";
import { type CheckpointRepoEntry, commitSubject, type DirtyRepo, pluralFiles } from "./checkpoint";
import type { GitCheckpointToolDetails } from "./tool";

const TOOL = "git_checkpoint";
/** Repos listed before the collapsed footer takes over. */
const REPO_LIMIT = 8;
/** Files named per repo when a row is expanded. */
const FILE_LIMIT = 8;

function plural(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function stageBadge(details: GitCheckpointToolDetails | undefined): Badge {
	switch (details?.stage) {
		case "committed":
			return { text: "commit", tone: "warning" };
		case "unmatched":
			return { text: "unmatched", tone: "error" };
		case "clean":
			return { text: "clean", tone: "success" };
		default:
			return { text: "list", tone: "accent" };
	}
}

/** File rows under one dirty repo, `… N more files` once past {@link FILE_LIMIT}. */
function fileRows(repo: DirtyRepo, theme: Theme): string {
	const files = repo.files ?? [];
	if (files.length === 0) return "";
	const shown = files.slice(0, FILE_LIMIT).map(file => `\n${theme.fg("dim", `  ${sanitize(file)}`)}`);
	const hidden = files.length - FILE_LIMIT;
	if (hidden > 0) shown.push(`\n${theme.fg("dim", `  … ${hidden} more ${hidden === 1 ? "file" : "files"}`)}`);
	return shown.join("");
}

function dirtyRepoRow(repo: DirtyRepo, expanded: boolean, theme: Theme): string {
	const label = theme.fg("accent", pathLabel(repo.label));
	const count = theme.fg("muted", pluralFiles(repo.changedFiles));
	return expanded ? `${label} ${count}${fileRows(repo, theme)}` : `${label} ${count}`;
}

function dirtyRows(dirty: readonly DirtyRepo[], expanded: boolean, theme: Theme): string[] {
	return collapsedList(dirty, repo => dirtyRepoRow(repo, expanded, theme), {
		expanded,
		limit: REPO_LIMIT,
		noun: "repo",
		theme,
	});
}

function entryRow(entry: CheckpointRepoEntry, expanded: boolean, theme: Theme): string {
	const label = theme.fg("accent", pathLabel(entry.label));
	const status = theme.fg(statusTone(entry.status), entry.status);
	const badgeText = `${theme.format.bracketLeft}${status}${theme.format.bracketRight}`;
	if (entry.status === "committed") {
		const facts = [entry.sha ?? "unknown", pluralFiles(entry.filesChanged)]
			.map(fact => theme.fg("dim", fact))
			.join(theme.sep.dot);
		const subject = commitSubject(entry.message);
		const rest = expanded && entry.message && entry.message.trim() !== subject ? entry.message.trim() : subject;
		const shown = rest === undefined ? "" : ` ${theme.fg("muted", sanitize(rest))}`;
		return `${badgeText} ${label} ${facts}${shown}`;
	}
	if (entry.status === "skipped") {
		return `${badgeText} ${label} ${theme.fg("dim", `no staged changes (${entry.reason ?? "no-changes"})`)}`;
	}
	const detail = sanitize(entry.error ?? "unknown error");
	const shown = expanded ? detail : (detail.split("\n")[0] ?? detail);
	return `${badgeText} ${label} ${theme.fg("error", shown)}`;
}

function outcomeFooter(entries: readonly CheckpointRepoEntry[]): string | undefined {
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
	const parts: string[] = [];
	const committed = counts.get("committed") ?? 0;
	const skipped = counts.get("skipped") ?? 0;
	const failed = counts.get("failed") ?? 0;
	if (committed > 0) parts.push(plural(committed, "commit"));
	if (skipped > 0) parts.push(`${skipped} skipped`);
	if (failed > 0) parts.push(`${failed} failed`);
	const head = parts.join(", ");
	return failed > 0 ? `${head} — partial checkpoint, see failed rows` : head;
}

/** Call row: the stage the agent is asking for, plus the repos it named. */
export function renderCheckpointCall(args: unknown, options: ToolRenderResultOptions, theme: Theme) {
	const raw = (args as { repos?: unknown } | undefined)?.repos;
	const repos = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
	const committing = repos.length > 0;
	return headerLine(theme, {
		tool: TOOL,
		icon: options.isPartial ? "running" : "pending",
		spinnerFrame: options.spinnerFrame,
		title: committing ? repos.join(", ") : "list dirty repos",
		badges: [{ text: committing ? "commit" : "list", tone: committing ? "warning" : "accent" }],
	});
}

export function renderCheckpointResult(
	result: AgentToolResult<GitCheckpointToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	_args?: unknown,
) {
	const details = result.details;
	if (!details) {
		const first = result.content[0];
		const text = first?.type === "text" ? sanitize(first.text) : "";
		if (result.isError) return errorCard(theme, TOOL, text);
		return headerLine(theme, {
			tool: TOOL,
			icon: options.isPartial ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: text.split("\n")[0],
			badges: [stageBadge(undefined)],
		});
	}
	const badgeSpec = stageBadge(details);
	const dirty = details.dirty ?? [];

	switch (details.stage) {
		case "clean":
			return toolCard(theme, {
				header: { tool: TOOL, icon: "success", badges: [badgeSpec] },
				body: [theme.fg("dim", "Nothing to commit — all repos are clean.")],
			});
		case "listed": {
			const rows = dirtyRows(dirty, options.expanded, theme);
			return toolCard(theme, {
				header: {
					tool: TOOL,
					icon: "success",
					title: `${plural(dirty.length, "repo")} with changes`,
					badges: [badgeSpec],
				},
				body: rows,
				footer: options.expanded ? "nothing was committed" : "nothing was committed — call again with repos=[…]",
			});
		}
		case "unmatched": {
			const unmatched = details.unmatched ?? [];
			const body = [
				theme.fg("error", `No dirty repo matches: ${sanitize(unmatched.join(", "))}`),
				...dirtyRows(dirty, options.expanded, theme),
			];
			return toolCard(theme, {
				header: { tool: TOOL, icon: "error", title: plural(unmatched.length, "unknown name"), badges: [badgeSpec] },
				body,
				footer: "nothing was committed",
			});
		}
		case "committed": {
			const entries = details.entries ?? [];
			const failed = entries.some(entry => entry.status === "failed");
			return toolCard(theme, {
				header: {
					tool: TOOL,
					icon: failed ? "error" : "success",
					title: plural(entries.length, "repo"),
					badges: [badgeSpec],
				},
				body: collapsedList(entries, entry => entryRow(entry, options.expanded, theme), {
					expanded: options.expanded,
					limit: REPO_LIMIT,
					noun: "repo",
					theme,
				}),
				footer: outcomeFooter(entries),
			});
		}
	}
}
