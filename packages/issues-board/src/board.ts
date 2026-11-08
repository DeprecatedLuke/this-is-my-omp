/**
 * The board: a list of one checkout's `.omp/issues`, ordered by `updated`.
 *
 * Issues come in four groups — Finished (archived and not yet looked at),
 * Active (everything else not archived), Awaiting deploy (`stage: awaiting-deploy`)
 * and Done (archived and seen), each newest `updated` first — one row per
 * issue. Keys — list: `j`/`k` and arrows move,
 * page keys and `g`/`G` jump, `enter` opens the detail view, `r` queues a reply
 * for the next agent prompt, `e` edits the issue file in nvim, `/` filters, `a`
 * toggles the Done window, `1`-`7` set the state, `q`/`ctrl+c` quits. Detail:
 * arrows/`jk`/page keys scroll, `esc` back, `r` reply, `e` edit.
 */

import * as fs from "node:fs";
import { openEditorOnPath } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import {
	applyBackgroundToLine,
	type Component,
	Ellipsis,
	extractPrintableText,
	Input,
	Markdown,
	matchesKey,
	ProcessTerminal,
	padding,
	ScrollView,
	TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-tui/key-hint-format";
import { getMarkdownTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { inline, keyValueRows, pathLabel, severityTone, statusTone, type Tone } from "@this-is-my-omp/render";
import { inboxDir, loadSeen, markSeen, type PendingReply, releaseClaim, setQueued } from "omp-issues/src/inbox";
import { type IssueRecord, listIssueRecords, moveIssue, replyToIssue } from "omp-issues/src/store";
import {
	BOARD_STATES,
	type BoardInbox,
	type BoardStateId,
	buildList,
	categoryTone,
	claimedBy,
	DONE_STATUSES,
	type DoneStatus,
	EMPTY_INBOX,
	EMPTY_SEEN,
	groupTone,
	isUnseen,
	LIST_GROUPS,
	type ListGroupId,
	type ListGroupView,
	loadInbox,
	loadReportBaseUrl,
	moveFor,
	pendingReplies,
	relativeAge,
	reportUrl,
	reportValue,
	type SeenState,
	stateGlyph,
	stateIdTone,
	stateLabel,
	stateOf,
	stateTitle,
	stateTone,
} from "./model";
import { type IssuesWatcher, watchIssues } from "./watch";

/** Width of the id column; wide enough for `#9999`. */
const ID_WIDTH = 5;
/** Width of the state chip column; wide enough for `✗ Finished · wontfix`. */
const CHIP_WIDTH = 20;
/** Width of the severity column; wide enough for `critical`. */
const SEVERITY_WIDTH = 8;
/** Title space a row needs before its category, then its age, is dropped. */
const MIN_TITLE_WIDTH = 18;
/** Header lines: identity + per-group counts. */
const HEADER_ROWS = 2;
/** Detail value column: widest key (`category`, `severity`) + gap + the row's leading space. */
const DETAIL_VALUE_INDENT = 11;
/** Session-id prefix a row shows; the detail view has the whole id. */
const CLAIM_SHOWN_CHARS = 6;

/** Where the board was started: the checkout root that holds `.omp/issues`. */
export interface BoardOptions {
	root: string;
	/** Issue to select and open on start (`--issue`, or a herdr link click). */
	focusIssue?: number;
}

/** One selectable row: the issue and the group it is listed under. */
interface ListEntry {
	record: IssueRecord;
	group: ListGroupId;
}

/** Single printable character of an input event, if it is one. */
function printableChar(data: string): string | undefined {
	const text = extractPrintableText(data);
	if (text === undefined) return undefined;
	const chars = [...text];
	return chars.length === 1 ? chars[0] : undefined;
}

/** OSC 8 hyperlink: a terminal that supports them opens `url` on ctrl+click. */
function hyperlink(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** Severity as a row shows it: critical stands out from high, unset is a dash. */
function paintSeverity(severity: string | undefined): string {
	if (!severity) return theme.fg("dim", "—");
	const tone = severityTone(severity);
	return theme.fg(tone, severity === "critical" ? theme.bold(severity) : severity);
}

/** Run the board until the user quits, restoring the terminal afterwards. */
export async function runBoard(options: BoardOptions): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const board = new BoardComponent(ui, options);
	await board.init();
	const overlay = ui.showOverlay(board, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
		mouseTracking: false,
	});
	ui.setFocus(board);
	ui.start();
	try {
		await board.run();
	} finally {
		board.dispose();
		overlay.hide();
		ui.stop();
	}
}

/** Fullscreen issue list: state, input, and both views. */
export class BoardComponent implements Component {
	readonly #ui: TUI;
	readonly #root: string;
	readonly #issuesRoot: string;
	readonly #repoName: string;
	readonly #focusIssueId: number | undefined;
	readonly #done = Promise.withResolvers<void>();
	readonly #listScroll = new ScrollView([], { height: 1, scrollbar: "auto", ellipsis: Ellipsis.Omit });
	readonly #detailScroll = new ScrollView([], { height: 1, scrollbar: "auto", ellipsis: Ellipsis.Omit });
	#records: IssueRecord[] = [];
	/** Machine-local replies and claims, reloaded with the records. */
	#inbox: BoardInbox = EMPTY_INBOX;
	/** What the user has already looked at, reloaded with the records. */
	#seen: SeenState = EMPTY_SEEN;
	/** Base url of the report site, if the user configured one. */
	#reportBase: string | undefined;
	#groups: ListGroupView[] = [];
	/** Every selectable row, in display order. */
	#order: ListEntry[] = [];
	/**
	 * Selected row: an index into {@link #order}, not an issue id. {@link #rebuild}
	 * keeps it on the same issue while other rows move, and on the same index when
	 * the issue under it moves itself.
	 */
	#cursor = 0;
	#view: "list" | "detail" = "list";
	#detailId: number | undefined;
	#markdown: { text: string; width: number; component: Markdown } | undefined;
	#filter = "";
	#filterInput: Input | undefined;
	#filtering = false;
	/** Open reply prompt: the issue it answers plus its single-line input. */
	#reply: { id: number; input: Input } | undefined;
	#showAllDone = false;
	#donePrompt: { id: number } | undefined;
	#status: { text: string; tone: Tone } | undefined;
	#watchers: IssuesWatcher[] = [];
	/** Rows the list body has, for page-sized jumps. */
	#bodyHeight = 1;
	#moving = false;
	#disposed = false;

	constructor(ui: TUI, options: BoardOptions) {
		this.#ui = ui;
		this.#root = options.root;
		this.#issuesRoot = `${options.root}/.omp/issues`;
		this.#repoName = options.root.split("/").filter(Boolean).at(-1) ?? options.root;
		this.#focusIssueId = options.focusIssue;
	}

	/** Load the first snapshot and start watching for agent and inbox writes. */
	async init(): Promise<void> {
		this.#reportBase = await loadReportBaseUrl(this.#root);
		await this.#reload();
		if (this.#focusIssueId !== undefined) this.#revealIssue(this.#focusIssueId);
		const onError = (error: Error): void => this.#setStatus("error", `watch: ${error.message}`);
		this.#watchers.push(watchIssues(this.#issuesRoot, () => void this.#reload(), { onError }));
		// Replies, queue marks and claims live outside the repo; watch them too so
		// an agent taking a reply shows up without a keypress. Watching needs the
		// directory to exist.
		const inbox = inboxDir(this.#root);
		try {
			fs.mkdirSync(inbox, { recursive: true });
			this.#watchers.push(watchIssues(inbox, () => void this.#reload(), { onError }));
		} catch (error) {
			this.#setStatus("error", `inbox: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	run(): Promise<void> {
		return this.#done.promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const watcher of this.#watchers) watcher.close();
		this.#watchers = [];
		this.#listScroll.dispose();
		this.#detailScroll.dispose();
		this.#done.resolve();
	}

	// -- data ------------------------------------------------------------------

	/**
	 * Reload every issue, its inbox state and the seen state, then regroup the
	 * list; {@link #rebuild} decides where the cursor lands.
	 */
	async #reload(): Promise<void> {
		if (this.#disposed) return;
		let records: IssueRecord[];
		let inbox: BoardInbox;
		let seen: SeenState;
		try {
			records = await listIssueRecords(this.#root);
			[inbox, seen] = await Promise.all([loadInbox(this.#root, records), loadSeen(this.#root)]);
		} catch (error) {
			this.#setStatus("error", `reload failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (this.#disposed) return;
		this.#records = records;
		this.#inbox = inbox;
		this.#seen = seen;
		this.#rebuild();
		this.#ui.requestRender();
	}

	/**
	 * Regroup the list and place the cursor.
	 *
	 * The cursor follows the issue it is on when *other* issues move (an agent
	 * edits or archives one, a new issue appears above, the filter or the Done
	 * window changes the rows around it). When the issue under the cursor moves
	 * itself — a state change, a reply, an agent update, or opening a Finished
	 * issue and marking it seen — the cursor stays at its row index instead and
	 * lands on whatever now occupies that slot. A changed group or `updated`
	 * stamp is what tells the two apart.
	 */
	#rebuild(): void {
		const selected = this.#order[this.#cursor];
		const before =
			selected === undefined
				? undefined
				: { id: selected.record.id, group: selected.group, updated: selected.record.frontmatter.updated };
		this.#groups = buildList(this.#records, {
			filter: this.#filter,
			showAllDone: this.#showAllDone,
			seen: this.#seen,
		});
		this.#order = this.#groups.flatMap(view => view.records.map(record => ({ record, group: view.group.id })));
		const after = before === undefined ? undefined : this.#order.find(entry => entry.record.id === before.id);
		const unmoved =
			before !== undefined &&
			after !== undefined &&
			after.group === before.group &&
			after.record.frontmatter.updated === before.updated;
		this.#cursor = unmoved ? this.#order.indexOf(after) : Math.max(0, Math.min(this.#cursor, this.#order.length - 1));
	}

	/**
	 * Swap in a record a store write just returned. Cheaper than a reload and,
	 * unlike one, it cannot race the watcher's own reload of the same change.
	 */
	#replaceRecord(record: IssueRecord): void {
		const index = this.#records.findIndex(candidate => candidate.id === record.id);
		if (index >= 0) this.#records[index] = record;
		else this.#records.push(record);
	}

	/** Note a just-queued reply locally, so its badge shows without a reload. */
	#rememberReply(id: number, reply: PendingReply): void {
		const replies = new Map(this.#inbox.replies);
		replies.set(id, [...(replies.get(id) ?? []), reply]);
		this.#inbox = { replies, claims: this.#inbox.claims };
	}

	#selectedEntry(): ListEntry | undefined {
		return this.#order[this.#cursor];
	}

	/** `--issue`/herdr handoff: show the issue (archived ones need the full window) and open it. */
	#revealIssue(id: number): void {
		const record = this.#records.find(candidate => candidate.id === id);
		if (!record) {
			this.#setStatus("error", `issue #${id} not found`);
			return;
		}
		if (record.archived && !this.#showAllDone) {
			this.#showAllDone = true;
			this.#rebuild();
		}
		const index = this.#order.findIndex(entry => entry.record.id === id);
		if (index < 0) {
			this.#setStatus("error", `issue #${id} not listed`);
			return;
		}
		this.#cursor = index;
		this.#openDetail();
	}

	#detailRecord(): IssueRecord | undefined {
		return this.#detailId === undefined ? undefined : this.#records.find(record => record.id === this.#detailId);
	}

	#setStatus(tone: Tone, text: string): void {
		this.#status = { text, tone };
		this.#ui.requestRender();
	}

	// -- actions ---------------------------------------------------------------

	#quit(): void {
		this.#done.resolve();
	}

	#moveSelection(delta: number): void {
		if (this.#order.length === 0) return;
		this.#cursor = Math.max(0, Math.min(this.#order.length - 1, this.#cursor + delta));
		this.#ui.requestRender();
	}

	#selectEdge(edge: "first" | "last"): void {
		if (this.#order.length === 0) return;
		this.#cursor = edge === "first" ? 0 : this.#order.length - 1;
		this.#ui.requestRender();
	}

	/** Set the selected issue's state; Done asks for the terminal status first. */
	#moveTo(state: BoardStateId): void {
		const entry = this.#selectedEntry();
		if (!entry || this.#moving) return;
		if (state === "done") {
			this.#donePrompt = { id: entry.record.id };
			this.#ui.requestRender();
			return;
		}
		if (!entry.record.archived && stateOf(entry.record) === state) return;
		void this.#applyMove(entry.record.id, state);
	}

	async #applyMove(id: number, state: BoardStateId, doneStatus?: DoneStatus): Promise<void> {
		const record = this.#records.find(candidate => candidate.id === id);
		if (!record || this.#moving) return;
		this.#moving = true;
		try {
			await moveIssue(this.#root, id, moveFor(state, record, doneStatus));
			// Moving an issue is the user taking it back: the claim goes, and only a
			// move to Up next queues it for this machine's agents.
			await releaseClaim(this.#root, id);
			await setQueued(this.#root, id, state === "up-next");
			this.#status = { text: `#${id} → ${stateTitle(state)}`, tone: "success" };
			// The issue's group may have changed; the cursor stays at its row.
			await this.#reload();
		} catch (error) {
			this.#setStatus("error", `#${id}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#moving = false;
			this.#ui.requestRender();
		}
	}

	#openDetail(): void {
		const entry = this.#selectedEntry();
		if (!entry) return;
		this.#detailId = entry.record.id;
		this.#view = "detail";
		this.#detailScroll.scrollToTop();
		void this.#markSeen(entry);
		this.#ui.requestRender();
	}

	/**
	 * Opening a Finished issue is the user seeing it: it moves to Done. The cursor
	 * stays at its row, which now holds whatever issue takes that slot.
	 */
	async #markSeen(entry: ListEntry): Promise<void> {
		if (entry.group !== "finished" || !isUnseen(entry.record, this.#seen)) return;
		const stamp = entry.record.frontmatter.updated;
		if (stamp === undefined) return;
		try {
			await markSeen(this.#root, entry.record.id, stamp);
		} catch (error) {
			this.#setStatus("error", `#${entry.record.id}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		await this.#reload();
	}

	async #edit(): Promise<void> {
		const record = this.#view === "detail" ? this.#detailRecord() : this.#selectedEntry()?.record;
		if (!record) return;
		const editor = "nvim";
		this.#ui.stop();
		try {
			await openEditorOnPath(editor, record.filePath);
		} catch (error) {
			this.#status = { text: `editor: ${error instanceof Error ? error.message : String(error)}`, tone: "error" };
		} finally {
			this.#ui.start();
			this.#ui.requestRender();
		}
		await this.#reload();
	}

	#startFilter(): void {
		if (!this.#filterInput) this.#filterInput = new Input();
		const input = this.#filterInput;
		input.prompt = `${theme.fg("accent", "/")} `;
		input.placeholder = "filter title, category, body";
		input.setValue(this.#filter);
		this.#filtering = true;
		this.#ui.requestRender();
	}

	#stopFilter(clear: boolean): void {
		this.#filtering = false;
		if (clear) this.#filter = "";
		this.#filterInput?.setValue(this.#filter);
		this.#rebuild();
		this.#ui.requestRender();
	}

	#toggleDoneWindow(): void {
		this.#showAllDone = !this.#showAllDone;
		this.#rebuild();
		this.#setStatus("muted", this.#showAllDone ? "Done: every archived issue" : "Done: last 7 days");
	}

	/** Open the reply prompt on the selected issue (or the open detail issue). */
	#startReply(): void {
		const record = this.#view === "detail" ? this.#detailRecord() : this.#selectedEntry()?.record;
		if (!record) return;
		const input = this.#reply?.input ?? new Input();
		input.prompt = `${theme.fg("accent", `#${record.id}`)} ${theme.fg("muted", "reply")} `;
		input.placeholder = "answer for the next agent prompt";
		input.setValue("");
		this.#reply = { id: record.id, input };
		this.#ui.requestRender();
	}

	#stopReply(): void {
		this.#reply = undefined;
		this.#ui.requestRender();
	}

	/**
	 * Queue the typed reply. The store moves the issue back to Up next (and
	 * unarchives it), which is the "back to unsolved" path; the cursor stays put.
	 */
	async #submitReply(id: number, text: string): Promise<void> {
		const reply = text.trim();
		this.#reply = undefined;
		if (reply === "") {
			this.#ui.requestRender();
			return;
		}
		try {
			const { record, reply: queued } = await replyToIssue(this.#root, id, reply);
			this.#replaceRecord(record);
			this.#rememberReply(id, queued);
			this.#rebuild();
			this.#status = { text: `#${id} reply queued for the next prompt`, tone: "success" };
		} catch (error) {
			this.#status = { text: `#${id}: ${error instanceof Error ? error.message : String(error)}`, tone: "error" };
		}
		this.#ui.requestRender();
	}

	// -- input -----------------------------------------------------------------

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#quit();
			return;
		}
		this.#status = undefined;
		if (this.#reply) {
			this.#replyKey(data);
			return;
		}
		if (this.#filtering) {
			this.#filterKey(data);
			return;
		}
		if (this.#donePrompt) {
			this.#doneKey(data);
			return;
		}
		if (this.#view === "detail") {
			this.#detailKey(data);
			return;
		}
		this.#listKey(data);
	}

	#listKey(data: string): void {
		const char = printableChar(data);
		if (matchesKey(data, "escape")) {
			if (this.#filter !== "") this.#stopFilter(true);
			return;
		}
		if (char === "q") {
			this.#quit();
			return;
		}
		if (char === "a") {
			this.#toggleDoneWindow();
			return;
		}
		if (char === "/") {
			this.#startFilter();
			return;
		}
		if (char === "r") {
			this.#startReply();
			return;
		}
		if (char === "e") {
			void this.#edit();
			return;
		}
		if (matchesKey(data, "enter") || char === "i") {
			this.#openDetail();
			return;
		}
		if (matchesKey(data, "up") || char === "k") {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(data, "down") || char === "j") {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.#moveSelection(-Math.max(1, this.#bodyHeight - 1));
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.#moveSelection(Math.max(1, this.#bodyHeight - 1));
			return;
		}
		if (char === "g") {
			this.#selectEdge("first");
			return;
		}
		if (char === "G") {
			this.#selectEdge("last");
			return;
		}
		if (char !== undefined && char >= "1" && char <= "7") {
			const target = BOARD_STATES[Number(char) - 1];
			if (target) this.#moveTo(target.id);
		}
	}

	#doneKey(data: string): void {
		const prompt = this.#donePrompt;
		if (!prompt) return;
		const char = printableChar(data);
		if (matchesKey(data, "escape") || char === "q") {
			this.#donePrompt = undefined;
			this.#ui.requestRender();
			return;
		}
		const picked = DONE_STATUSES.find(status => status[0] === char);
		if (!picked) return;
		this.#donePrompt = undefined;
		void this.#applyMove(prompt.id, "done", picked);
	}

	#filterKey(data: string): void {
		const input = this.#filterInput;
		if (!input) return;
		if (matchesKey(data, "escape")) {
			this.#stopFilter(true);
			return;
		}
		if (matchesKey(data, "enter")) {
			this.#stopFilter(false);
			return;
		}
		input.handleInput(data);
		const value = input.getValue();
		if (value !== this.#filter) {
			this.#filter = value;
			this.#rebuild();
		}
		this.#ui.requestRender();
	}

	#replyKey(data: string): void {
		const reply = this.#reply;
		if (!reply) return;
		if (matchesKey(data, "escape")) {
			this.#stopReply();
			return;
		}
		if (matchesKey(data, "enter")) {
			void this.#submitReply(reply.id, reply.input.getValue());
			return;
		}
		reply.input.handleInput(data);
		this.#ui.requestRender();
	}

	#detailKey(data: string): void {
		const char = printableChar(data);
		if (matchesKey(data, "escape") || char === "h") {
			this.#view = "list";
			this.#ui.requestRender();
			return;
		}
		if (char === "q") {
			this.#quit();
			return;
		}
		if (char === "r") {
			this.#startReply();
			return;
		}
		if (char === "e") {
			void this.#edit();
			return;
		}
		if (this.#detailScroll.handleScrollKey(data)) {
			this.#ui.requestRender();
			return;
		}
		if (char === "j") this.#detailScroll.scroll(1);
		else if (char === "k") this.#detailScroll.scroll(-1);
		else if (char === "g") this.#detailScroll.scrollToTop();
		else if (char === "G") this.#detailScroll.scrollToBottom();
		else return;
		this.#ui.requestRender();
	}

	// -- render ----------------------------------------------------------------

	render(width: number): readonly string[] {
		const safeWidth = Math.max(20, width);
		const height = Math.max(8, this.#ui.terminal.rows);
		return this.#view === "detail" ? this.#renderDetail(safeWidth, height) : this.#renderList(safeWidth, height);
	}

	#headerLines(width: number): string[] {
		const identity = ` ${theme.fg("accent", "▌")} ${theme.bold("omp-board")} ${theme.fg("dim", "·")} ${theme.bold(this.#repoName)} ${theme.fg("dim", pathLabel(this.#root))}`;
		const right = this.#headerChips();
		const gap = Math.max(1, width - visibleWidth(identity) - visibleWidth(right));
		const line1 = truncateToWidth(`${identity}${padding(gap)}${right}`, width, Ellipsis.Omit);

		const counts = LIST_GROUPS.map(group => {
			const total = this.#groups.find(view => view.group.id === group.id)?.records.length ?? 0;
			return `${theme.fg(groupTone(group.id), group.title)} ${theme.bold(String(total))}`;
		}).join(theme.fg("dim", " · "));
		const line2 = truncateToWidth(` ${counts}`, width, Ellipsis.Omit);
		return [line1, line2];
	}

	#headerChips(): string {
		const chips: string[] = [];
		if (this.#filter !== "") chips.push(theme.fg("accent", `/${inline(this.#filter)}`));
		if (this.#showAllDone) chips.push(theme.fg("warning", "done: all"));
		if (chips.length === 0) {
			const total = this.#groups.reduce((sum, view) => sum + view.records.length, 0);
			chips.push(theme.fg("dim", `${total} issue${total === 1 ? "" : "s"}`));
		}
		return `${chips.join(theme.fg("dim", " · "))} `;
	}

	#renderList(width: number, height: number): string[] {
		const footer = this.#footerLines(width, "list");
		const bodyHeight = Math.max(3, height - HEADER_ROWS - 1 - footer.length);
		this.#bodyHeight = bodyHeight;
		const header = this.#headerLines(width);
		const rule = truncateToWidth(theme.fg("dim", "─".repeat(width)), width, Ellipsis.Omit);
		const { lines, selectedLine } = this.#listLines(width);
		this.#listScroll.setLines(lines);
		this.#listScroll.setHeight(bodyHeight);
		if (selectedLine >= 0) this.#listScroll.setActiveRow(selectedLine, "nearest");
		const body = this.#listScroll.render(width);
		const out = [...header, rule, ...body, ...footer];
		while (out.length < height) out.push("");
		return out.slice(0, height);
	}

	/** Every list row plus the line index of the selected one, for the scroll view. */
	#listLines(width: number): { lines: string[]; selectedLine: number } {
		const lines: string[] = [];
		let selectedLine = -1;
		let row = 0;
		const now = Date.now();
		if (this.#groups.length === 0) {
			lines.push(theme.fg("dim", this.#filter === "" ? " (no issues)" : " (no match)"));
			return { lines, selectedLine };
		}
		for (const [index, view] of this.#groups.entries()) {
			const count = view.records.length;
			// A blank line and a coloured, ruled header make each group boundary obvious.
			if (index > 0) lines.push("");
			const tone = groupTone(view.group.id);
			const label = ` ${theme.fg(tone, "▌")} ${theme.bold(theme.fg(tone, view.group.title))} ${theme.fg("muted", String(count))} `;
			const rule = theme.fg(tone, "─".repeat(Math.max(0, width - visibleWidth(label))));
			lines.push(truncateToWidth(`${label}${rule}`, width, Ellipsis.Omit));
			for (const record of view.records) {
				const selected = row === this.#cursor;
				if (selected) selectedLine = lines.length;
				row++;
				lines.push(this.#rowLine(record, view.group.id, width, selected, now));
			}
		}
		return { lines, selectedLine };
	}

	/**
	 * One issue on one line: `#id`, state chip, severity, title, then the badges,
	 * category and age on the right. Category goes first, then the age, when the
	 * terminal leaves too little room for the title.
	 */
	#rowLine(record: IssueRecord, group: ListGroupId, width: number, selected: boolean, now: number): string {
		const marker = selected ? theme.fg("accent", "▌") : " ";
		const settled = group === "done";
		const idText = theme.bold(theme.fg(settled ? "muted" : "text", `#${record.id}`));
		const id = `${idText}${padding(Math.max(0, ID_WIDTH - visibleWidth(idText)))}`;
		const tone = stateTone(record, group);
		const label = `${stateGlyph(record, group)} ${stateLabel(record, group)}`;
		const chip = theme.fg(tone, `${label}${padding(Math.max(0, CHIP_WIDTH - visibleWidth(label)))}`);
		const severityText = paintSeverity(record.frontmatter.severity);
		const severity = `${severityText}${padding(Math.max(0, SEVERITY_WIDTH - visibleWidth(severityText)))}`;
		const left = `${marker}${id} ${chip} ${severity} `;
		const leftWidth = visibleWidth(left);
		const badges = this.#rowBadges(record);
		const category = theme.fg(settled ? "dim" : categoryTone(record.category), inline(record.category));
		const age = theme.fg("dim", relativeAge(record, now));
		let right = [badges, category, age].filter(part => part !== "");
		const titleRoom = (parts: readonly string[]): number =>
			width - leftWidth - (parts.length === 0 ? 0 : visibleWidth(parts.join(" ")) + 2);
		if (titleRoom(right) < MIN_TITLE_WIDTH) right = right.filter(part => part !== category);
		if (titleRoom(right) < MIN_TITLE_WIDTH) right = right.filter(part => part !== age);
		const rightText = right.join(" ");
		const titleText = truncateToWidth(
			inline(record.frontmatter.title ?? "(untitled)"),
			Math.max(4, titleRoom(right)),
			Ellipsis.Unicode,
		);
		const title = settled ? theme.fg("muted", titleText) : titleText;
		const gap = Math.max(
			1,
			width - leftWidth - visibleWidth(title) - (rightText === "" ? 0 : visibleWidth(rightText) + 1),
		);
		const line = `${left}${title}${padding(gap)}${rightText}`;
		return selected ? applyBackgroundToLine(line, width, text => theme.bg("selectedBg", text)) : line;
	}

	/**
	 * Badges before the category: a pending user reply, the omp session that
	 * claimed the issue, and a report link. All optional, so an untouched issue
	 * keeps a plain `#id state severity title` line.
	 */
	#rowBadges(record: IssueRecord): string {
		const badges: string[] = [];
		if (pendingReplies(this.#inbox, record.id).length > 0) badges.push(theme.fg("warning", "reply"));
		const claim = claimedBy(this.#inbox, record.id);
		if (claim !== undefined) badges.push(theme.fg("accent", `⧗ ${claim.slice(0, CLAIM_SHOWN_CHARS)}`));
		if (reportValue(record) !== undefined) badges.push(theme.fg("accent", "report"));
		return badges.length === 0 ? "" : `${badges.join(theme.fg("dim", " · "))} `;
	}

	#footerLines(width: number, view: "list" | "detail"): string[] {
		const status = this.#statusLine(width);
		const hints =
			view === "list"
				? [
						`${formatKeyHints(["up", "down"])} ${formatKeyHint("j")}${formatKeyHint("k")} move`,
						`${formatKeyHint("enter")} detail`,
						`${formatKeyHint("r")} reply`,
						`${formatKeyHint("e")} edit`,
						"/ filter",
						`${formatKeyHint("a")} done`,
						`${formatKeyHint("q")} quit`,
					].join(theme.fg("dim", " · "))
				: [
						`${formatKeyHints(["up", "down"])} ${formatKeyHint("j")}${formatKeyHint("k")} scroll`,
						`${formatKeyHint("escape")} back`,
						`${formatKeyHint("r")} reply`,
						`${formatKeyHint("e")} edit`,
						`${formatKeyHint("q")} quit`,
					].join(theme.fg("dim", " · "));
		const lines = [status, truncateToWidth(` ${theme.fg("dim", hints)}`, width, Ellipsis.Omit)];
		if (view === "list") {
			// What each state key sets, in the colour its chip will take.
			const keys = BOARD_STATES.map(
				(state, index) => `${formatKeyHint(String(index + 1))} ${theme.fg(stateIdTone(state.id), state.title)}`,
			).join(theme.fg("dim", " · "));
			lines.push(truncateToWidth(` ${keys}`, width, Ellipsis.Omit));
		}
		return lines;
	}

	#statusLine(width: number): string {
		const prompt = this.#donePrompt;
		if (prompt) {
			const choices = DONE_STATUSES.map(status => `${theme.fg("accent", status[0]!)} ${status}`).join(
				theme.fg("dim", " · "),
			);
			return truncateToWidth(
				` ${theme.bold(`#${prompt.id}`)} → Done as: ${choices} ${theme.fg("dim", `· ${formatKeyHint("escape")} cancel`)}`,
				width,
				Ellipsis.Omit,
			);
		}
		if (this.#reply) {
			const hint = ` ${theme.fg("dim", `${formatKeyHint("enter")} queue · ${formatKeyHint("escape")} cancel`)}`;
			const line = this.#reply.input.render(Math.max(20, width - visibleWidth(hint)))[0] ?? "";
			return truncateToWidth(`${line}${hint}`, width, Ellipsis.Omit);
		}
		if (this.#filtering && this.#filterInput) {
			return truncateToWidth(this.#filterInput.render(width)[0] ?? "", width, Ellipsis.Omit);
		}
		if (this.#status) {
			return truncateToWidth(` ${theme.fg(this.#status.tone, inline(this.#status.text))}`, width, Ellipsis.Omit);
		}
		return "";
	}

	#renderDetail(width: number, height: number): string[] {
		const footer = this.#footerLines(width, "detail");
		const bodyHeight = Math.max(3, height - 1 - footer.length);
		const record = this.#detailRecord();
		const title = record
			? ` ${theme.bold(`#${record.id}`)} ${theme.bold(inline(record.frontmatter.title ?? "(untitled)"))}`
			: ` ${theme.fg("dim", "issue")}`;
		const header = truncateToWidth(title, width, Ellipsis.Omit);
		let body: string[];
		if (!record) {
			body = ["", theme.fg("dim", " This issue is no longer on disk.")];
		} else {
			body = [...this.#detailFields(record, width), "", ...this.#detailBody(record, width)];
		}
		this.#detailScroll.setLines(body);
		this.#detailScroll.setHeight(bodyHeight);
		const lines = [header, ...this.#detailScroll.render(width), ...footer];
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	#detailFields(record: IssueRecord, width: number): string[] {
		const frontmatter = record.frontmatter;
		const group = this.#groups.find(view => view.records.some(candidate => candidate.id === record.id))?.group.id;
		const rows: [string, string][] = [
			["id", `#${record.id}`],
			["title", inline(frontmatter.title ?? "(untitled)")],
			["category", record.category],
			[
				"state",
				group === undefined
					? theme.fg(stateTone(record, "active"), stateLabel(record, "active"))
					: theme.fg(stateTone(record, group), stateLabel(record, group)),
			],
			["severity", frontmatter.severity ? paintSeverity(frontmatter.severity) : theme.fg("dim", "—")],
			[
				"status",
				frontmatter.status ? theme.fg(statusTone(frontmatter.status), frontmatter.status) : theme.fg("dim", "—"),
			],
			["stage", frontmatter.stage ?? theme.fg("dim", "—")],
			["created", frontmatter.created ?? theme.fg("dim", "—")],
			["updated", frontmatter.updated ?? theme.fg("dim", "—")],
		];
		const locations = frontmatter.location ?? [];
		for (const location of locations) rows.push(["location", inline(location)]);
		const report = reportValue(record);
		if (report !== undefined) {
			const url = reportUrl(report, this.#reportBase);
			// A configured site gets a real OSC 8 link (ctrl+click opens it in the
			// user's browser); without one the issue's own value is shown as written.
			rows.push([
				"report",
				url === report ? theme.fg("accent", inline(report)) : hyperlink(url, theme.fg("accent", url)),
			]);
		}
		const claim = claimedBy(this.#inbox, record.id);
		if (claim !== undefined) rows.push(["claimed", theme.fg("accent", claim)]);
		const replies = pendingReplies(this.#inbox, record.id);
		for (const [index, reply] of replies.entries()) {
			// Wrapped under the value column: the first line carries the key, the
			// rest continue with an empty one so `keyValueRows` keeps them aligned.
			const wrapped = wrapTextWithAnsi(inline(reply.text), Math.max(20, width - DETAIL_VALUE_INDENT));
			rows.push([index === 0 ? "reply" : "", theme.fg("warning", wrapped[0] ?? "")]);
			for (const line of wrapped.slice(1)) rows.push(["", theme.fg("warning", line)]);
			rows.push(["", theme.fg("dim", reply.at)]);
		}
		return keyValueRows(theme, rows).map(row => ` ${row}`);
	}

	#detailBody(record: IssueRecord, width: number): string[] {
		const text = record.body.trim() === "" ? "_No description._" : record.body;
		const bodyWidth = Math.max(20, width - 2);
		if (this.#markdown?.text !== text || this.#markdown.width !== bodyWidth) {
			this.#markdown = {
				text,
				width: bodyWidth,
				component: new Markdown(text, 0, 0, getMarkdownTheme()),
			};
		}
		return [...this.#markdown.component.render(bodyWidth)].map(line => ` ${line}`);
	}
}
