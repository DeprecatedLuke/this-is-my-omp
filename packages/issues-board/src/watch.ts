/**
 * Live reload for the issues board: watch a directory tree recursively and call
 * back (debounced) whenever an agent, editor or omp session writes a file. The
 * board points it at `<root>/.omp/issues` and at the user's issues inbox.
 *
 * Bun's `fs.watch(dir, { recursive: true })` is inotify-backed and reports
 * files created in directories that appear after the watch started (verified on
 * Linux, Bun 1.4), so one watcher covers `.archive/` and every category
 * directory. Where recursive watching is unavailable the watcher falls back to
 * one watcher per directory, re-armed whenever a directory appears.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Handle of a running watch; `close()` stops it and drops pending callbacks. */
export interface IssuesWatcher {
	close(): void;
}

export interface WatchOptions {
	/** Coalescing window; agent writes come in bursts. */
	debounceMs?: number;
	/** Called when the watch itself fails (the board shows it in the footer). */
	onError?: (error: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 150;

/** The root plus every subdirectory below it, so nested state (a reply's own directory) is covered too. */
function watchedDirectories(root: string): string[] {
	const dirs = [root];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const child = path.join(dir, entry.name);
			dirs.push(child);
			walk(child);
		}
	};
	walk(root);
	return dirs;
}

/**
 * Watch `issuesRoot` and invoke `onChange` after each burst of filesystem
 * events. Never throws: a watch that cannot start reports through `onError`,
 * and a directory that disappears simply stops producing events.
 */
export function watchIssues(issuesRoot: string, onChange: () => void, options: WatchOptions = {}): IssuesWatcher {
	const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	const watchers: fs.FSWatcher[] = [];

	const report = (error: unknown): void => {
		options.onError?.(error instanceof Error ? error : new Error(String(error)));
	};

	const fire = (): void => {
		if (closed) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (!closed) onChange();
		}, debounceMs);
	};

	const arm = (dir: string, recursive: boolean, onEvent: () => void): fs.FSWatcher | undefined => {
		try {
			const watcher = fs.watch(dir, { recursive, persistent: true }, onEvent);
			watcher.on("error", report);
			watchers.push(watcher);
			return watcher;
		} catch (error) {
			report(error);
			return undefined;
		}
	};

	if (!arm(issuesRoot, true, fire)) {
		// Recursive watching unavailable: cover the root and each directory, and
		// re-arm on every event so a category created later is picked up.
		const flat = new Map<string, fs.FSWatcher>();
		const armFlat = (): void => {
			for (const dir of watchedDirectories(issuesRoot)) {
				if (flat.has(dir)) continue;
				const watcher = arm(dir, false, () => {
					armFlat();
					fire();
				});
				if (watcher) flat.set(dir, watcher);
			}
		};
		armFlat();
	}

	return {
		close() {
			closed = true;
			clearTimeout(timer);
			timer = undefined;
			for (const watcher of watchers) {
				try {
					watcher.close();
				} catch {
					// Already closed by the runtime.
				}
			}
			watchers.length = 0;
		},
	};
}
