/**
 * Shared TUI rendering kit for this-is-my-omp plugins.
 *
 * Thin layer over the host's built-in tool-card primitives (`renderStatusLine`,
 * `framedToolCard`, tree glyphs, `formatMoreItems`) so plugin tool cards look
 * native next to built-in ones. Every caller-supplied string is sanitized
 * (control chars, ANSI and tabs removed) and every rendered row is truncated
 * to the width the component receives at render time.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import {
	formatMoreItems,
	framedToolCard,
	PREVIEW_LIMITS,
	pluralize,
	renderStatusLine,
	replaceTabs,
	shortenPath,
	type ToolCardPhase,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export type { Component } from "@oh-my-pi/pi-tui";
export type { Theme } from "@oh-my-pi/pi-tui/theme";

/** Semantic color of a badge or label; every tone is a host theme color. */
export type Tone = "accent" | "muted" | "dim" | "success" | "warning" | "error";

/** A bracketed, colored label such as `[high]`. */
export interface Badge {
	text: string;
	tone: Tone;
}

/** Status glyph shown at the start of a header row. */
export type HeaderIcon = "pending" | "running" | "success" | "error" | "warning";

/** Inputs for a single tool status row. */
export interface HeaderSpec {
	/** Tool display name, rendered as the accent title (e.g. `Issues`). */
	tool: string;
	icon?: HeaderIcon;
	/** Spinner frame index; animates the `running` icon. */
	spinnerFrame?: number;
	/** Short subject after the tool name, rendered muted (`Tool: title`). */
	title?: string;
	badges?: Badge[];
	/** Dim facts joined by the theme dot separator. */
	meta?: string[];
}

/** Inputs for a framed tool card. */
export interface CardSpec {
	header: HeaderSpec;
	/** Pre-styled body rows; split on newlines, tab/control-sanitized, truncated to width. */
	body?: string[];
	/** Short facts drawn into the bottom border (wrapped above it when too wide). */
	footer?: string;
}

/** Render options the host passes to `renderCall` / `renderResult`. */
export interface RenderOptions {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
}

// ── Sanitization ────────────────────────────────────────────────────────────

/**
 * Display-safe text: strips ANSI escapes and control characters (keeping
 * newlines) and expands tabs, so raw model or file text can never move the
 * cursor or misalign a frame.
 */
export function sanitize(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** {@link sanitize} plus newline flattening, for single-row labels. */
export function inline(text: string): string {
	return sanitize(text)
		.replace(/\s*\n\s*/g, " ")
		.trim();
}

/** Home directory shortened to `~`, sanitized for display. */
export function pathLabel(path: string): string {
	return inline(shortenPath(path));
}

/**
 * Sanitize an already-styled row: keep SGR styling, expand tabs and drop stray
 * control bytes (C0 except ESC/LF, DEL, C1) so nothing but printable text and
 * the caller's own color codes reaches the terminal.
 */
function cleanStyled(line: string): string {
	const tabbed = line.includes("\t") ? replaceTabs(line) : line;
	let clean: string | undefined;
	for (let i = 0; i < tabbed.length; i++) {
		const code = tabbed.charCodeAt(i);
		if (code === 10 || code === 27 || (code >= 32 && (code < 127 || code > 159))) {
			if (clean !== undefined) clean += tabbed[i];
			continue;
		}
		clean ??= tabbed.slice(0, i);
	}
	return clean ?? tabbed;
}

/** Split styled rows on newlines and clean each one. */
function styledRows(lines: readonly string[]): string[] {
	const rows: string[] = [];
	for (const line of lines) {
		for (const row of line.split(/\r?\n/)) rows.push(cleanStyled(row));
	}
	return rows;
}

// ── Tones and badges ────────────────────────────────────────────────────────

function normalizeKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
}

/** Bracketed, tone-colored label in the theme's bracket glyphs. */
export function badge(theme: Theme, b: Badge): string {
	return theme.fg(b.tone, `${theme.format.bracketLeft}${inline(b.text)}${theme.format.bracketRight}`);
}

/** critical/high → error, medium → warning, low → muted, info → dim; unknown → muted. */
export function severityTone(severity: string): Tone {
	switch (normalizeKey(severity)) {
		case "critical":
		case "high":
		case "p0":
		case "p1":
			return "error";
		case "medium":
		case "p2":
			return "warning";
		case "info":
			return "dim";
		default:
			return "muted";
	}
}

/**
 * open → accent, in-progress → warning, done/closed/committed → success,
 * failed/error → error, archived/skipped → dim; unknown → muted.
 */
export function statusTone(status: string): Tone {
	switch (normalizeKey(status)) {
		case "open":
		case "new":
		case "pending":
			return "accent";
		case "in-progress":
		case "running":
		case "active":
			return "warning";
		case "done":
		case "closed":
		case "committed":
		case "completed":
		case "resolved":
		case "success":
			return "success";
		case "failed":
		case "error":
			return "error";
		case "archived":
		case "skipped":
			return "dim";
		default:
			return "muted";
	}
}

// ── Headers ─────────────────────────────────────────────────────────────────

/**
 * One status row in the built-in look: `<icon> Tool: title [badge] meta·meta`.
 * The row is not truncated (callers embed it in frames that clip their label);
 * use {@link headerLine} for a standalone, width-safe component.
 */
export function toolHeader(theme: Theme, spec: HeaderSpec): string {
	const title = spec.title === undefined ? "" : inline(spec.title);
	let line = renderStatusLine(
		{
			icon: spec.icon,
			spinnerFrame: spec.spinnerFrame,
			title: inline(spec.tool),
			description: title || undefined,
		},
		theme,
	);
	for (const b of spec.badges ?? []) {
		if (inline(b.text)) line += ` ${badge(theme, b)}`;
	}
	const meta = (spec.meta ?? []).map(inline).filter(value => value.length > 0);
	if (meta.length > 0) line += ` ${theme.fg("dim", meta.join(theme.sep.dot))}`;
	return line;
}

/** Component rendering pre-styled rows, each cleaned and truncated to the render width. */
class TruncatedRows implements Component {
	readonly #rows: string[];
	#width = -1;
	#rendered: readonly string[] = [];

	constructor(rows: readonly string[]) {
		this.#rows = styledRows(rows);
	}

	render(width: number): readonly string[] {
		if (width !== this.#width) {
			this.#width = width;
			const max = Math.max(1, width);
			this.#rendered = this.#rows.map(row => truncateToWidth(row, max));
		}
		return this.#rendered;
	}

	invalidate(): void {
		this.#width = -1;
	}
}

/** Header row as a standalone component (typical `renderCall` output), truncated to width. */
export function headerLine(theme: Theme, spec: HeaderSpec): Component {
	return new TruncatedRows([toolHeader(theme, spec)]);
}

/** Pre-styled rows as an unframed component (inline results), truncated to width. */
export function lines(rows: readonly string[]): Component {
	return new TruncatedRows(rows);
}

// ── Cards ───────────────────────────────────────────────────────────────────

function borderFor(icon: HeaderIcon | undefined): ThemeColor | undefined {
	switch (icon) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "pending":
		case "running":
			return undefined;
		default:
			return "borderMuted";
	}
}

/**
 * Framed card matching built-in tool cards: the header rides the top border,
 * body rows are cleaned and truncated to the frame's inner width at render
 * time, the footer rides the bottom border.
 */
export function toolCard(theme: Theme, spec: CardSpec): Component {
	const header = toolHeader(theme, spec.header);
	const body = styledRows(spec.body ?? []);
	const footer = spec.footer === undefined ? "" : inline(spec.footer);
	const icon = spec.header.icon;
	let memoWidth = -1;
	let memoRows: string[] = [];
	return framedToolCard(theme, ({ contentWidth }) => {
		if (contentWidth !== memoWidth) {
			memoWidth = contentWidth;
			const max = Math.max(1, contentWidth);
			memoRows = body.map(row => truncateToWidth(row, max));
		}
		return {
			header,
			sections: memoRows.length > 0 ? [{ content: memoRows }] : [],
			footerMeta: footer ? theme.fg("dim", footer) : undefined,
			phase: (icon ?? "info") satisfies ToolCardPhase,
			borderColor: borderFor(icon),
			applyBg: icon === "error" ? undefined : false,
		};
	});
}

/** Framed error card: error icon header plus the sanitized message in the theme error color. */
export function errorCard(theme: Theme, tool: string, message: string): Component {
	const text = sanitize(message)
		.replace(/^\s*Error:\s*/, "")
		.trimEnd();
	const all = (text || "Unknown error").split("\n");
	const max = PREVIEW_LIMITS.EXPANDED_LINES;
	const shown = all.length > max ? all.slice(0, max - 1) : all;
	const body = shown.map(line => `  ${theme.fg("error", line)}`);
	const hidden = all.length - shown.length;
	if (hidden > 0) body.push(`  ${theme.fg("dim", `… ${hidden} more ${pluralize("line", hidden)}`)}`);
	return toolCard(theme, { header: { tool, icon: "error" }, body });
}

// ── Lists and rows ──────────────────────────────────────────────────────────

/**
 * Tree-branched rows in the built-in list look. Collapsed, only the first
 * `limit` items render (default {@link PREVIEW_LIMITS.COLLAPSED_ITEMS}) and a
 * dim `… N more <noun>s` footer counts the rest; expanded renders all items.
 * Multi-line item renders continue under the branch with the vertical glyph.
 * Rows carry no width of their own: compose them into {@link toolCard} (which
 * truncates to the frame's inner width) or {@link lines}.
 */
export function collapsedList<T>(
	items: readonly T[],
	render: (item: T) => string,
	opts: { expanded: boolean; limit?: number; noun: string; theme: Theme },
): string[] {
	const { theme } = opts;
	const limit = Math.max(1, Math.floor(opts.limit ?? PREVIEW_LIMITS.COLLAPSED_ITEMS));
	const shown = opts.expanded ? items.length : Math.min(limit, items.length);
	const hidden = items.length - shown;
	const out: string[] = [];
	for (let i = 0; i < shown; i++) {
		const isLast = i === shown - 1 && hidden === 0;
		const branch = theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch);
		const cont = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;
		const rows = styledRows([render(items[i]!)]);
		out.push(`${branch} ${rows[0] ?? ""}`);
		for (let r = 1; r < rows.length; r++) out.push(`${cont}${rows[r]}`);
	}
	if (hidden > 0)
		out.push(`${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", formatMoreItems(hidden, opts.noun))}`);
	return out;
}

/**
 * `key  value` rows with dim keys padded to a shared column. Values may carry
 * the caller's own theme styling; pass raw external text through
 * {@link sanitize} first.
 */
export function keyValueRows(theme: Theme, rows: ReadonlyArray<readonly [string, string]>): string[] {
	const keys = rows.map(([key]) => inline(key));
	const width = keys.reduce((max, key) => Math.max(max, Bun.stringWidth(key)), 0);
	return rows.map(([, value], i) => {
		const key = keys[i]!;
		const pad = " ".repeat(width - Bun.stringWidth(key));
		return `${theme.fg("dim", `${key}${pad}`)}  ${cleanStyled(value.replace(/\s*\r?\n\s*/g, " "))}`;
	});
}
