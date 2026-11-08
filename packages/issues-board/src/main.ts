/**
 * `omp-board` entrypoint: dispatch `api` to the JSON API, else resolve the
 * checkout, initialise the theme the way omp's own fullscreen commands do, and
 * run the board.
 *
 * Theme setup mirrors `omp git`: load the user's settings first so the
 * configured theme, symbol preset and colour-blind mode apply, then
 * `initTheme` with those values. A bare `initTheme()` would fall back to the
 * built-in defaults and the board would not match the rest of the terminal.
 */
import * as path from "node:path";
import { runApi } from "./api";
import { type BoardArgs, BoardUsageError, findCheckoutRoot, parseBoardArgs, USAGE } from "./cli";
import { herdrContextCwd, herdrFocusIssue } from "./herdr";

/**
 * Load the terminal UI and run it.
 *
 * The imports are dynamic because they cannot be static: `omp-board api` is
 * called per keypress by front ends that draw the board themselves, and omp's
 * settings, the theme stack and pi-tui are several hundred milliseconds of
 * module work that path must not pay for.
 */
async function startTui(root: string, focusIssue: number | undefined): Promise<void> {
	const [{ Settings, settings }, modes, { initTheme }, { runBoard }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/config/settings"),
		import("@oh-my-pi/pi-coding-agent/modes/settings"),
		import("@oh-my-pi/pi-tui/theme"),
		import("./board"),
	]);
	await Settings.init({ cwd: root });
	await initTheme(
		false,
		modes.cfgSymbolPreset.get(settings),
		modes.cfgColorBlindMode.get(settings),
		modes.cfgThemeDark.get(settings),
		modes.cfgThemeLight.get(settings),
	);
	await runBoard({ root, focusIssue });
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv[0] === "api") return await runApi(argv.slice(1));
	let args: BoardArgs;
	try {
		args = parseBoardArgs(argv);
	} catch (error) {
		if (!(error instanceof BoardUsageError)) throw error;
		console.error(`omp-board: ${error.message}\n${USAGE}`);
		return 2;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	const start = path.resolve(args.path ?? herdrContextCwd() ?? process.cwd());
	const root = findCheckoutRoot(start);
	if (root === undefined) {
		console.error(`no .omp/issues found at or above ${start}`);
		return 1;
	}
	if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
		console.error("omp-board is interactive and requires a TTY");
		return 1;
	}
	await startTui(root, args.issue ?? herdrFocusIssue());
	return 0;
}

try {
	process.exit(await main());
} catch (error) {
	console.error(`omp-board: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
