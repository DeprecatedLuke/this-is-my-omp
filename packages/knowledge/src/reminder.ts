/**
 * End-of-turn knowledge reminder: once a top-level session has done enough
 * non-cached provider work since the last watermark, the main agent is asked to
 * catalogue what it learned into `knowledge://` itself.
 *
 * The watermark is a durable session entry, so the reminder fires once per
 * threshold crossing and re-arms only after another threshold's worth of work.
 * Only the decision lives here; `index.ts` queues the hint on `agent_end`.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { prompt } from "@oh-my-pi/pi-utils";
import reminderTemplate from "./prompts/reminder.md" with { type: "text" };

/**
 * Custom session entry holding `{ throughEntryId }`: work up to that message has
 * already been offered for cataloguing. The id predates the reminder (it marked
 * completed background distills), so existing sessions keep their watermark.
 */
export const KNOWLEDGE_WATERMARK_CUSTOM_TYPE = "knowledge-auto-update";

/** Hidden custom message carrying the knowledge hint into the next turn. */
export const KNOWLEDGE_REMINDER_MESSAGE_TYPE = "knowledge-reminder";

export interface KnowledgeWatermark {
	throughEntryId: string;
}

export interface UncataloguedWork {
	/** Primary session messages after the watermark. */
	messages: SessionMessageEntry[];
	/** Positive finite non-cached assistant work tokens (`input + output + cacheWrite`) in {@link messages}; cache reads and `totalTokens` are excluded. */
	totalTokens: number;
}

/** Return positive finite provider work that was not replayed from the prompt cache. */
function getNonCachedAssistantWorkTokens(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	const usage = message.usage;
	const tokens = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
	return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
}

/**
 * Collect the primary session messages past the watermark and their non-cached provider-work total.
 *
 * A marker's `throughEntryId` defines the real boundary even when the marker
 * itself was appended after newer messages. A referenced marker whose boundary
 * is absent from the scanned branch — a stale or malformed cross-branch
 * watermark — is ignored rather than treated as a reset, so pending work is
 * never erased. Plain legacy markers reset at their physical position.
 */
export function collectUncataloguedWork(entries: readonly SessionEntry[]): UncataloguedWork {
	const messages: SessionMessageEntry[] = [];
	let totalTokens = 0;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === KNOWLEDGE_WATERMARK_CUSTOM_TYPE) {
			const markerData = entry.data;
			const throughEntryId =
				markerData !== null &&
				typeof markerData === "object" &&
				"throughEntryId" in markerData &&
				typeof markerData.throughEntryId === "string"
					? markerData.throughEntryId
					: undefined;
			if (throughEntryId !== undefined) {
				let boundaryIndex = -1;
				for (let index = messages.length - 1; index >= 0; index--) {
					if (messages[index].id === throughEntryId) {
						boundaryIndex = index;
						break;
					}
				}
				if (boundaryIndex >= 0) {
					let removedTokens = 0;
					for (let index = 0; index <= boundaryIndex; index++) {
						removedTokens += getNonCachedAssistantWorkTokens(messages[index].message);
					}
					const retainedCount = messages.length - boundaryIndex - 1;
					if (retainedCount > 0) messages.copyWithin(0, boundaryIndex + 1);
					messages.length = retainedCount;
					totalTokens -= removedTokens;
				}
				// A referenced marker whose boundary is absent from the scanned
				// branch is stale or malformed (e.g. a cross-branch watermark):
				// ignore it instead of clearing pending work.
			} else {
				// Plain legacy marker: reset at its physical position.
				messages.length = 0;
				totalTokens = 0;
			}
			continue;
		}
		if (entry.type !== "message") continue;
		messages.push(entry);
		totalTokens += getNonCachedAssistantWorkTokens(entry.message);
	}
	return { messages, totalTokens };
}

/** A due reminder: the work it covers and the watermark that retires it. */
export interface KnowledgeReminderPlan {
	/** Non-cached provider work since the previous watermark. */
	totalTokens: number;
	/** Watermark to append before reminding: the latest message on the branch. */
	watermark: KnowledgeWatermark;
}

export interface KnowledgeReminderDecisionOptions {
	/** Active branch entries of the session. */
	entries: readonly SessionEntry[];
	/** `reminderThresholdTokens`; `<= 0`, NaN, or infinite disables the reminder. */
	thresholdTokens: number;
	/** Only a top-level session is reminded; subagents never are. */
	agentKind: "main" | "sub";
	/**
	 * The session will wake again on its own or already owns `.omp/knowledge`:
	 * background work pending, a `/knowledge` pass in flight, or a reminder
	 * already sent for this prompt.
	 */
	busy: boolean;
}

/**
 * Decide whether the turn that is about to settle should end with a knowledge
 * reminder. Pure: the caller appends {@link KnowledgeReminderPlan.watermark}
 * (so the reminder cannot repeat for the same work) and renders the text.
 */
export function decideKnowledgeReminder(options: KnowledgeReminderDecisionOptions): KnowledgeReminderPlan | undefined {
	if (options.agentKind !== "main") return undefined;
	if (options.busy) return undefined;
	const { thresholdTokens } = options;
	if (!(thresholdTokens > 0) || !Number.isFinite(thresholdTokens)) return undefined;
	const work = collectUncataloguedWork(options.entries);
	if (work.messages.length === 0) return undefined;
	if (work.totalTokens < thresholdTokens) return undefined;
	return {
		totalTokens: work.totalTokens,
		watermark: { throughEntryId: work.messages[work.messages.length - 1].id },
	};
}

/** Model-visible reminder text for {@link KnowledgeReminderPlan.totalTokens} of uncatalogued work. */
export function renderKnowledgeReminder(totalTokens: number): string {
	return prompt.render(reminderTemplate, { tokens: Math.round(totalTokens).toLocaleString("en-US") });
}
