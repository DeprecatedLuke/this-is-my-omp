/**
 * `omp-board` entrypoint: resolve the checkout, initialise the theme the way
 * omp's own fullscreen commands do, and run the board.
 *
 * Theme setup mirrors `omp git`: load the user's settings first so the
 * configured theme, symbol preset and colour-blind mode apply, then
 * `initTheme` with those values. A bare `initTheme()` would fall back to the
 * built-in defaults and the board would not match the rest of the terminal.
 */
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgColorBlindMode,
	cfgSymbolPreset,
	cfgThemeDark,
	cfgThemeLight,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { runBoard } from "./board";
import { type BoardArgs, BoardUsageError, findCheckoutRoot, parseBoardArgs, USAGE } from "./cli";
import { herdrContextCwd, herdrFocusIssue } from "./herdr";

async function main(): Promise<number> {
	let args: BoardArgs;
	try {
		args = parseBoardArgs(process.argv.slice(2));
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
	await Settings.init({ cwd: root });
	await initTheme(
		false,
		cfgSymbolPreset.get(settings),
		cfgColorBlindMode.get(settings),
		cfgThemeDark.get(settings),
		cfgThemeLight.get(settings),
	);
	await runBoard({ root, focusIssue: args.issue ?? herdrFocusIssue() });
	return 0;
}

try {
	process.exit(await main());
} catch (error) {
	console.error(`omp-board: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
