/**
 * `/git-checkpoint [repo...]` — the operator path. The user owns every dirty repo
 * in the workspace, so a bare invocation commits all of them in one step; naming
 * repos narrows it to those (matched exactly like the tool's stage two). Agents go
 * through the `git_checkpoint` tool instead.
 */
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { commitCheckpointRepos, dirtyRepos, formatCheckpointResult, selectDirtyRepos } from "./checkpoint";

/** Split the command's raw argument string into repo names. */
export function parseRepoArgs(args: string): string[] {
	return args
		.split(/[\s,]+/)
		.map(value => value.trim())
		.filter(value => value.length > 0);
}

export async function runGitCheckpointCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const names = parseRepoArgs(args);
	try {
		const dirty = await dirtyRepos(ctx.cwd);
		if (dirty.length === 0) {
			ctx.ui.notify("Nothing to commit — all repos are clean.", "info");
			return;
		}
		const { selected, unmatched } =
			names.length > 0 ? selectDirtyRepos(ctx.cwd, dirty, names) : { selected: dirty, unmatched: [] };
		if (unmatched.length > 0) {
			ctx.ui.notify(`No dirty repo matches: ${unmatched.join(", ")}. Nothing was committed.`, "error");
			return;
		}
		ctx.ui.notify(`Checkpointing ${selected.length} repo${selected.length === 1 ? "" : "s"}…`, "info");
		const entries = await commitCheckpointRepos(selected, {
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			settings: Settings.instance,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		const text = formatCheckpointResult(entries);
		if (entries.some(entry => entry.status === "failed")) ctx.ui.notify(text, "error");
		else ctx.ui.notify(text, "info");
	} catch (error) {
		ctx.ui.notify(`Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
