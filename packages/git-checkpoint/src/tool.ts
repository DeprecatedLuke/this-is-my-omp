/**
 * `git_checkpoint` tool: the agent-facing form of the two-stage WIP checkpoint flow.
 * Bare it lists the dirty repos and commits nothing, so the caller must name exactly
 * the repos it is responsible for; with names it commits only those, each with a
 * locally generated message.
 */

import type * as zod from "@oh-my-pi/omptype/zod";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import gitCheckpointPrompt from "../prompts/git-checkpoint.md" with { type: "text" };
import {
	type CheckpointCommitDeps,
	type CheckpointRepoEntry,
	type DirtyRepo,
	formatCheckpointResult,
	formatDirtyRepoList,
	runCheckpointStage,
} from "./checkpoint";
import { renderCheckpointCall, renderCheckpointResult } from "./render";

export interface GitCheckpointToolDetails {
	stage: "clean" | "listed" | "unmatched" | "committed";
	/** Dirty repos the stage saw; these labels are what stage two accepts. */
	dirty: DirtyRepo[];
	/** Requested names that matched no dirty repo (nothing was committed). */
	unmatched?: string[];
	/** Per-repo commit outcomes, in selection order. */
	entries?: CheckpointRepoEntry[];
}

export interface GitCheckpointToolParams {
	repos?: string[];
}

/** Everything the tool needs from the calling session. */
export interface CheckpointSession {
	cwd: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	sessionId?: string;
}

/** Zod-compatible schema builder supplied by the host (`pi.zod`). */
export type ZodBuilder = typeof zod;

function toolParameters(zod: ZodBuilder): TSchema {
	return zod.object({
		repos: zod
			.array(zod.string())
			.optional()
			.describe("stage-2 repo names, exactly as listed by a bare git_checkpoint call; omit to list dirty repos"),
	});
}

/**
 * Run the two-stage flow for a session. Exported separately from the tool definition
 * so tests can drive it without an extension host.
 */
export async function runGitCheckpoint(
	params: GitCheckpointToolParams,
	session: CheckpointSession,
	signal?: AbortSignal,
): Promise<AgentToolResult<GitCheckpointToolDetails>> {
	return untilAborted(signal, async () => {
		const deps: CheckpointCommitDeps = {
			modelRegistry: session.modelRegistry,
			settings: session.settings,
			sessionId: session.sessionId,
		};
		const result = await runCheckpointStage(session.cwd, params.repos ?? [], deps);
		switch (result.stage) {
			case "clean":
				return {
					content: [{ type: "text", text: "Nothing to commit — all repos are clean." }],
					details: { stage: "clean", dirty: [] } satisfies GitCheckpointToolDetails,
				};
			case "listed":
				return {
					content: [
						{
							type: "text",
							text: [
								`Detected repos with changes:\n${formatDirtyRepoList(result.dirty)}`,
								"Call git_checkpoint again with `repos` naming only the repos you are responsible for.",
							].join("\n\n"),
						},
					],
					details: { stage: "listed", dirty: result.dirty } satisfies GitCheckpointToolDetails,
				};
			case "unmatched":
				return {
					content: [
						{
							type: "text",
							text: [
								`No dirty repo matches: ${result.unmatched.join(", ")}`,
								`Detected repos with changes:\n${formatDirtyRepoList(result.dirty)}`,
								"Nothing was committed.",
							].join("\n\n"),
						},
					],
					details: {
						stage: "unmatched",
						dirty: result.dirty,
						unmatched: result.unmatched,
					} satisfies GitCheckpointToolDetails,
					isError: true,
				};
			case "committed": {
				const failed = result.entries.some(entry => entry.status === "failed");
				return {
					content: [{ type: "text", text: formatCheckpointResult(result.entries) }],
					details: {
						stage: "committed",
						dirty: result.dirty,
						entries: result.entries,
					} satisfies GitCheckpointToolDetails,
					// Omitted (not `false`) on success: the host treats a present flag as a tool error.
					...(failed ? { isError: true } : {}),
				};
			}
		}
	});
}

/** Build the `git_checkpoint` tool definition for {@link ExtensionContext}. */
export function createGitCheckpointTool(zod: ZodBuilder): ToolDefinition<TSchema, GitCheckpointToolDetails> {
	return {
		name: "git_checkpoint",
		label: "Git Checkpoint",
		description: prompt.render(gitCheckpointPrompt),
		parameters: toolParameters(zod),
		approval: "write",
		loadMode: "discoverable",
		strict: true,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runGitCheckpoint(
				params as GitCheckpointToolParams,
				{
					cwd: ctx.cwd,
					modelRegistry: ctx.modelRegistry,
					settings: Settings.instance,
					sessionId: ctx.sessionManager.getSessionId(),
				},
				signal,
			);
		},
		renderCall: (args, options, theme) => renderCheckpointCall(args as GitCheckpointToolParams, options, theme),
		renderResult: (result, options, theme, args) =>
			renderCheckpointResult(
				result as AgentToolResult<GitCheckpointToolDetails>,
				options,
				theme,
				args as GitCheckpointToolParams | undefined,
			),
	};
}
