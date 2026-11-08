/**
 * herdr (terminal multiplexer) glue for the issues board.
 *
 * herdr launches plugin commands with the plugin directory as their working
 * directory, so the board cannot take the repository from `process.cwd()`. herdr
 * injects `HERDR_PLUGIN_CONTEXT_JSON` instead: the invocation context of the pane
 * the plugin was invoked from. Both helpers are pure reads of `process.env` and
 * never throw on malformed input.
 */

/** Env var the `open-issue` action hands the clicked issue id to the popup board. */
const FOCUS_ISSUE_ENV = "OMP_BOARD_FOCUS_ISSUE";

interface HerdrWorktreeContext {
	checkout_path?: unknown;
}

interface HerdrInvocationContext {
	workspace_cwd?: unknown;
	focused_pane_cwd?: unknown;
	worktree?: HerdrWorktreeContext | null;
	clicked_url?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pluginContext(): HerdrInvocationContext | undefined {
	const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
	if (!raw) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as HerdrInvocationContext;
}

/**
 * Working directory of the herdr pane the board was opened from
 * (`HERDR_PLUGIN_CONTEXT_JSON`); undefined outside herdr or when absent.
 *
 * The focused pane's own cwd is the directory the user is looking at, so it wins.
 * When that is the plugin root itself — the board pane is focused and the user
 * asked for a board again — the workspace's worktree checkout is the next best
 * answer, then the workspace cwd. herdr derives the workspace cwd from the
 * focused pane, so it is the last resort rather than the first.
 */
export function herdrContextCwd(): string | undefined {
	const context = pluginContext();
	if (!context) {
		return undefined;
	}
	const pluginRoot = nonEmptyString(process.env.HERDR_PLUGIN_ROOT);
	const candidates = [
		nonEmptyString(context.focused_pane_cwd),
		nonEmptyString(context.worktree?.checkout_path),
		nonEmptyString(context.workspace_cwd),
	];
	for (const candidate of candidates) {
		if (candidate && candidate !== pluginRoot) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Issue id to open on, from a herdr link click on `issues://<id>` (or the plugin's
 * own handoff); undefined otherwise.
 *
 * A link-click action receives the clicked URL in its context, but the pane it
 * opens does not, so the `open-issue` action passes the id on as
 * `OMP_BOARD_FOCUS_ISSUE` through `herdr plugin pane open --env`. An env handoff
 * rather than a file under `HERDR_PLUGIN_STATE_DIR`: when `bun` runs inside a
 * filesystem sandbox that does not bind `~/.local/state`, a state-dir file is
 * invisible to the board, while the environment always gets through.
 */
export function herdrFocusIssue(): number | undefined {
	const clickedUrl = nonEmptyString(pluginContext()?.clicked_url);
	const fromClick = clickedUrl ? /^issues:\/\/(\d+)$/.exec(clickedUrl.trim()) : null;
	if (fromClick) {
		return Number(fromClick[1]);
	}
	const handoff = /^(?:issues:\/\/)?(\d+)$/.exec(nonEmptyString(process.env[FOCUS_ISSUE_ENV])?.trim() ?? "");
	return handoff ? Number(handoff[1]) : undefined;
}
