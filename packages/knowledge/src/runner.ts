/**
 * Orchestration for every knowledge pass the plugin runs.
 *
 * Mechanism (why not `ctx.runEphemeralTurn` or a task subprocess):
 * - `runEphemeralTurn` cannot execute tools, and every pass is a tool loop.
 * - The extension API exposes no subagent spawn, and the internal subprocess
 *   executor needs the live session's event bus, MCP manager, skills, prompt
 *   templates and telemetry — none of which an extension can provide.
 * - So each pass is a headless `Agent` (the same primitive the core used for
 *   this feature) whose tools are bound to the pass directory. Passes that must
 *   not touch the working tree still run through the host's native-patch
 *   machinery, so their edits arrive as a reviewable `patch://` capture.
 */
import type { AgentOptions } from "@oh-my-pi/pi-agent-core";
import { type Api, type Message, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import { obfuscateProviderContext } from "@oh-my-pi/pi-coding-agent/secrets";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { TaskPatchSummary } from "@oh-my-pi/pi-coding-agent/task/types";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { runSessionKnowledgeAgent } from "./agent-pass";
import { runIsolatedKnowledgePass } from "./passes";
import knowledgeBuildTemplate from "./prompts/knowledge-build.md" with { type: "text" };
import knowledgeCompactTemplate from "./prompts/knowledge-compact.md" with { type: "text" };
import knowledgeUpdateTemplate from "./prompts/knowledge-update.md" with { type: "text" };
import sessionKnowledgeTemplate from "./prompts/session-knowledge.md" with { type: "text" };
import { diffKnowledgeSnapshots, type KnowledgeChange, snapshotKnowledge } from "./snapshot";
import { buildPassObfuscator, createPassTools, hostSettings, MAINTENANCE_TOOLS, NOTE_TOOLS } from "./tools";

/** Verification needs `grep`/`glob`; a session distill never needs a shell. */
const SAVE_TOOLS = [...NOTE_TOOLS, "grep", "glob"] as const;

export type KnowledgePassKind = "save" | "update" | "compact" | "build";

export interface KnowledgePassReport {
	kind: KnowledgePassKind;
	/** Human title for the card, e.g. `Knowledge update`. */
	title: string;
	status: "completed" | "empty" | "failed" | "aborted" | "pending";
	/** Notes created/updated/deleted in the real tree. */
	changes: KnowledgeChange[];
	/** Patches left pending/conflicted (the edits did not land in the tree). */
	patches: TaskPatchSummary[];
	/** Commit created for the landed edits, when one was made. */
	commit?: string;
	summary?: string;
	error?: string;
	durationMs: number;
}

export interface PassContext {
	cwd: string;
	model: Model<Api>;
	apiKey: string;
	signal?: AbortSignal;
	/** Live system prompt of the calling session, for session-seeded passes. */
	systemPrompt: string[];
}

interface AgentOptionsParts {
	cwd: string;
	/** Directory the tools are bound to: the worktree for isolated passes. */
	toolCwd: string;
	model: Model<Api>;
	apiKey: string;
	systemPrompt: string[];
	messages: readonly Message[];
	tools: readonly string[];
}

async function buildAgentOptions(parts: AgentOptionsParts): Promise<AgentOptions> {
	const settings = await hostSettings();
	const obfuscator = await buildPassObfuscator(parts.cwd, settings);
	return {
		initialState: {
			systemPrompt: parts.systemPrompt,
			messages: [...parts.messages],
			model: parts.model,
			tools: createPassTools(parts.toolCwd, settings, parts.tools),
		},
		streamFn: streamSimple,
		getApiKey: () => parts.apiKey,
		convertToLlm,
		...(obfuscator
			? {
					transformProviderContext: (context: Parameters<typeof obfuscateProviderContext>[1]) =>
						obfuscateProviderContext(obfuscator, context),
				}
			: {}),
	};
}

/** Distill the current session into `.omp/knowledge` and commit the subtree. Powers `/knowledge save`. */
export async function runSavePass(
	context: PassContext,
	options: { messages: readonly Message[]; sourceTitle: string },
): Promise<KnowledgePassReport> {
	const startedAt = Date.now();
	const title = "Knowledge save";
	const before = await snapshotKnowledge(context.cwd);
	if (options.messages.length === 0) {
		return {
			kind: "save",
			title,
			status: "empty",
			changes: [],
			patches: [],
			error: "no session context to distill",
			durationMs: Date.now() - startedAt,
		};
	}
	const result = await runSessionKnowledgeAgent({
		cwd: context.cwd,
		sourceTitle: options.sourceTitle,
		signal: context.signal,
		commit: true,
		instruction: prompt.render(sessionKnowledgeTemplate, { sourceTitle: options.sourceTitle }),
		agent: await buildAgentOptions({
			cwd: context.cwd,
			toolCwd: context.cwd,
			model: context.model,
			apiKey: context.apiKey,
			systemPrompt: context.systemPrompt,
			messages: options.messages,
			tools: SAVE_TOOLS,
		}),
	});
	const changes = diffKnowledgeSnapshots(before, await snapshotKnowledge(context.cwd));
	const status = !result.completed
		? context.signal?.aborted
			? "aborted"
			: "failed"
		: changes.length === 0
			? "empty"
			: "completed";
	return {
		kind: "save",
		title,
		status,
		changes,
		patches: [],
		commit: result.sha,
		durationMs: Date.now() - startedAt,
	};
}

/** A landed edit set is `completed`; edits parked as a patch are `pending`. */
function changesStatus(
	changes: readonly KnowledgeChange[],
	patches: readonly TaskPatchSummary[],
): KnowledgePassReport["status"] {
	if (changes.length > 0) return "completed";
	return patches.length > 0 ? "pending" : "empty";
}

/**
 * Maintenance passes (`update`, `compact`, `build`) run in an isolated worktree
 * and land as a native patch: they never need the conversation, only the
 * repository and the existing notes.
 */
export async function runMaintenancePass(
	context: PassContext,
	options: {
		kind: "update" | "compact" | "build";
		focus?: string;
		goal?: string;
		taskId: string;
		isolationBackend?: Parameters<typeof runIsolatedKnowledgePass>[0]["isolationBackend"];
	},
): Promise<KnowledgePassReport> {
	const startedAt = Date.now();
	const focus = options.focus?.trim() || undefined;
	const goal = options.goal?.trim() || undefined;
	const spec = describeMaintenance(options.kind, { focus, goal });
	const pass = await runIsolatedKnowledgePass({
		cwd: context.cwd,
		taskId: options.taskId,
		description: spec.description,
		isolationBackend: options.isolationBackend,
		generateMessage: async () => `chore(knowledge): update .omp/knowledge\n\nSource: ${spec.sourceTitle}`,
		runInWorktree: async worktreeDir => {
			const agent = await buildAgentOptions({
				cwd: context.cwd,
				toolCwd: worktreeDir,
				model: context.model,
				apiKey: context.apiKey,
				systemPrompt: [spec.systemPrompt],
				messages: [],
				tools: MAINTENANCE_TOOLS,
			});
			const result = await runSessionKnowledgeAgent({
				cwd: worktreeDir,
				sourceTitle: spec.sourceTitle,
				signal: context.signal,
				commit: false,
				instruction: spec.task,
				agent,
			});
			return { exitCode: result.completed ? 0 : 1, aborted: context.signal?.aborted === true };
		},
	});
	if (pass.aborted) logger.debug("knowledge pass aborted", { kind: options.kind });
	return {
		kind: options.kind,
		title: spec.title,
		status:
			pass.aborted || context.signal?.aborted
				? "aborted"
				: pass.exitCode !== 0
					? "failed"
					: changesStatus(pass.changes, pass.patches),
		changes: pass.changes,
		patches: pass.patches,
		summary: pass.summary,
		durationMs: Date.now() - startedAt,
	};
}

interface MaintenanceSpec {
	title: string;
	description: string;
	sourceTitle: string;
	systemPrompt: string;
	task: string;
}

function describeMaintenance(
	kind: "update" | "compact" | "build",
	input: { focus?: string; goal?: string },
): MaintenanceSpec {
	switch (kind) {
		case "build":
			return {
				title: input.focus ? `Knowledge build (${input.focus})` : "Knowledge build",
				description: "Explore the project and author the knowledge base.",
				sourceTitle: input.focus ? `/knowledge build ${input.focus}` : "/knowledge build",
				systemPrompt: prompt.render(knowledgeBuildTemplate, { focus: input.focus }),
				task: input.focus
					? `Explore the project and build the knowledge base (focus: ${input.focus}).`
					: "Explore the project and build the knowledge base.",
			};
		case "compact":
			return {
				title: input.goal ? `Knowledge compact (${input.goal})` : "Knowledge compact",
				description: input.goal
					? "Maintain the project knowledge base toward a goal."
					: "Prune and consolidate the project knowledge base.",
				sourceTitle: input.goal ? `/knowledge compact ${input.goal}` : "/knowledge compact",
				systemPrompt: prompt.render(knowledgeCompactTemplate, { goal: input.goal }),
				task: input.goal ?? "Compact the project knowledge base.",
			};
		default:
			return {
				title: input.focus ? `Knowledge update (${input.focus})` : "Knowledge update",
				description: "Verify and reconcile the project knowledge base.",
				sourceTitle: input.focus ? `/knowledge update ${input.focus}` : "/knowledge update",
				systemPrompt: prompt.render(knowledgeUpdateTemplate, { focus: input.focus }),
				task: input.focus
					? `Verify and reconcile the project knowledge base (focus: ${input.focus}).`
					: "Verify and reconcile the project knowledge base.",
			};
	}
}
