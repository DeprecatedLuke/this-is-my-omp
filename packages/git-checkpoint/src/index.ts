/**
 * omp-git-checkpoint plugin: local WIP checkpoint commits across the workspace's git
 * repos.
 *
 * - `git_checkpoint` tool (discoverable, so also `xd://git_checkpoint`): two stages —
 *   list the dirty repos, then commit only the named ones.
 * - `/git-checkpoint [repo...]`: operator path, commits every dirty repo (or the named
 *   ones) in one step.
 * - `before_agent_start`: the main agent gets the checkpoint policy appended to its
 *   system prompt. Subagents skip it: they share the workspace with their parent, so a
 *   checkpoint from a subagent would commit work that is still in flight.
 *
 * `omp git checkpoint` no longer exists; the tool and the slash command replace it.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import systemPromptSection from "../prompts/system.md" with { type: "text" };
import { runGitCheckpointCommand } from "./command";
import { createGitCheckpointTool } from "./tool";

export default function gitCheckpointPlugin(pi: ExtensionAPI): void {
	pi.setLabel("git-checkpoint");

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		return { systemPrompt: [...event.systemPrompt, prompt.render(systemPromptSection)] };
	});

	pi.registerTool(createGitCheckpointTool(pi.zod));

	pi.registerCommand("git-checkpoint", {
		description: "git-checkpoint: commit every dirty repo (or the named repos) as local WIP checkpoints",
		handler: async (args, ctx) => {
			await runGitCheckpointCommand(args, ctx);
		},
	});
}
