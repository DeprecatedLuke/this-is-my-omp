/**
 * Headless knowledge pass: a real agent loop that edits `.omp/knowledge/**`
 * through the `read`/`write`/`edit` tools on `knowledge://` URLs and then
 * commits ONLY the knowledge subtree.
 */
import { Agent, type AgentOptions } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { commitKnowledgeFiles } from "./commit";

/**
 * Everything required to drive one headless knowledge pass.
 *
 * `agent` carries the request shape the caller can provide: the seeded
 * `initialState` (systemPrompt + messages + model + tool instances), the
 * `streamFn`/`getApiKey`/`convertToLlm` triple, the outbound
 * `transformProviderContext` (secret mask) and inbound
 * `transformToolCallArguments` (secret de-mask), the
 * `sessionId`/`promptCacheKey` cache keys, and the thinking/temperature config.
 */
export interface RunSessionKnowledgeAgentConfig {
	/** Working directory whose `.omp/knowledge` subtree is updated and committed. */
	cwd: string;
	/** Human label recorded on the knowledge commit and in debug logs. */
	sourceTitle: string;
	/** Developer instruction appended as the final turn that drives the pass (save vs compact). */
	instruction: string;
	/** Aborts both the agent loop and the commit. */
	signal?: AbortSignal;
	/**
	 * Commit the knowledge subtree after the pass (default `true`). Set `false`
	 * when an outer flow captures the edits as a native patch and owns the
	 * commit — the agent then writes `.omp/knowledge` but leaves it staged for
	 * the caller.
	 */
	commit?: boolean;
	/** Agent options assembled by the caller. */
	agent: AgentOptions;
	/** Static request metadata forwarded to the provider (e.g. Anthropic session attribution). */
	metadata?: Record<string, unknown>;
}

export interface RunSessionKnowledgeAgentResult {
	committed: boolean;
	/** True when the headless agent pass completed without abort or failure. */
	completed: boolean;
	/** Abbreviated SHA of the knowledge commit, when one was made. */
	sha?: string;
}

/**
 * Run a real headless agent loop that edits `.omp/knowledge/**` through the
 * `read`/`write`/`edit` tools on `knowledge://` URLs, then commits ONLY the
 * knowledge subtree.
 *
 * The loop appends a developer instruction to the seeded session context and
 * runs to turn-end (the model stops calling tools). Designed for
 * fire-and-forget callers: it NEVER throws — any failure or abort surfaces as
 * `{ committed: false, completed: false }`.
 */
export async function runSessionKnowledgeAgent(
	config: RunSessionKnowledgeAgentConfig,
): Promise<RunSessionKnowledgeAgentResult> {
	const { cwd, sourceTitle, signal } = config;
	if (signal?.aborted) return { committed: false, completed: false };

	const seededMessages = config.agent.initialState?.messages ?? [];

	const agent = new Agent({
		...config.agent,
	});
	// Static metadata already resolved for this provider by the caller; setting
	// it clears any inherited resolver, which is correct for a one-shot pass.
	if (config.metadata) agent.metadata = config.metadata;

	const onAbort = () => agent.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const instruction: Message = {
			role: "developer",
			content: [{ type: "text", text: config.instruction }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		logger.debug("Session knowledge update started", { sourceTitle, messageCount: seededMessages.length });
		await agent.prompt(instruction);
		await agent.waitForIdle();
		if (signal?.aborted) return { committed: false, completed: false };
		// Provider, agent, or tool failures can resolve `prompt` normally instead
		// of throwing: stream failures surface through `agent.state.error` and/or
		// a terminal assistant `stopReason: "error"`, while tool failures append
		// a `toolResult` with `isError: true`. Treat any as an incomplete pass —
		// never report `completed: true` for it.
		let terminalAssistant: AssistantMessage | undefined;
		let hasFailedToolResult = false;
		const runMessages = agent.state.messages;
		for (let index = seededMessages.length; index < runMessages.length; index++) {
			const message = runMessages[index];
			if (message.role === "assistant") {
				terminalAssistant = message;
			} else if (message.role === "toolResult" && message.isError === true) {
				hasFailedToolResult = true;
			}
		}
		if (agent.state.error || terminalAssistant?.stopReason === "error" || hasFailedToolResult) {
			return { committed: false, completed: false };
		}

		// Patch-based callers capture the written edits themselves and own the
		// commit; the agent only writes the subtree here.
		if (config.commit === false) return { committed: false, completed: true };

		const result = await commitKnowledgeFiles(cwd, { sourceTitle, signal });
		logger.debug("Session knowledge update complete", {
			sourceTitle,
			committed: result.committed,
			sha: result.sha,
			reason: result.reason,
		});
		return { committed: result.committed, completed: true, sha: result.sha };
	} catch (error) {
		if (signal?.aborted) return { committed: false, completed: false };
		logger.debug("Failed to update session knowledge", {
			sourceTitle,
			error: error instanceof Error ? error.message : String(error),
		});
		return { committed: false, completed: false };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
