/**
 * Command line of `omp-board`: argument parsing and checkout discovery.
 *
 * The board reads and writes `<root>/.omp/issues`, so it needs the checkout
 * root, not the current directory: `omp-board` run from `packages/foo/src`
 * finds the same board as one run from the repository top.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Parsed command line. */
export interface BoardArgs {
	/** Explicit start directory (the positional argument). */
	path?: string;
	/** Issue to select and open on start. */
	issue?: number;
	/** `--help`/`-h` was given. */
	help: boolean;
}

/** Thrown for a malformed command line; `main` prints it with the usage line. */
export class BoardUsageError extends Error {}

export const USAGE = `usage: omp-board [path] [--issue <id>]
       omp-board api <verb> [args] --root <path>

api verbs (one JSON object on stdout, exit 1 with {"error": ...} on failure):
  snapshot [--filter TEXT] [--all-done]
  wait --since <fingerprint> [--timeout-ms N] [--filter TEXT] [--all-done]
  detail <id>
  seen <id>
  move <id> <state> [--status fixed|wontfix|duplicate]
  reply <id>            (reply text on stdin)`;

/** Parse `[path] [--issue <id>]`. */
export function parseBoardArgs(argv: readonly string[]): BoardArgs {
	const args: BoardArgs = { help: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--help" || arg === "-h") {
			args.help = true;
			continue;
		}
		if (arg === "--issue" || arg.startsWith("--issue=")) {
			const raw = arg === "--issue" ? argv[++index] : arg.slice("--issue=".length);
			if (raw === undefined) throw new BoardUsageError("--issue needs an issue id");
			const id = Number.parseInt(raw, 10);
			if (!Number.isFinite(id) || id <= 0 || String(id) !== raw.trim()) {
				throw new BoardUsageError(`--issue needs a positive issue id, got '${raw}'`);
			}
			args.issue = id;
			continue;
		}
		if (arg.startsWith("-")) throw new BoardUsageError(`unknown option '${arg}'`);
		if (args.path !== undefined) throw new BoardUsageError(`unexpected argument '${arg}'`);
		args.path = arg;
	}
	return args;
}

/** Nearest directory at or above `start` that contains `.omp/issues`. */
export function findCheckoutRoot(start: string): string | undefined {
	let dir = path.resolve(start);
	try {
		if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
	} catch {
		return undefined;
	}
	for (;;) {
		if (fs.existsSync(path.join(dir, ".omp", "issues"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
