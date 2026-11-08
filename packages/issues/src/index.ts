/**
 * omp-issues plugin: the project-local issue tracker.
 *
 * Everything the feature needs lives here or next to it:
 * - the `issues` tool (discoverable, so hosts mount it as `xd://issues`),
 * - the `issues://` URL scheme (read/edit side, plus its prompt doc),
 * - the end-of-turn in-progress reminder,
 * - the `§ Filed Issues` catalogue injected into subagent prompts that can file,
 * - the parent-UI rendering of issues a reviewer subagent files,
 * - `agents/reviewer.md`, the issue-filing reviewer definition.
 *
 * The tracker stores plain markdown under `<cwd>/.omp/issues/`, so the data
 * stays with the project when this plugin is uninstalled.
 */
import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";
import { boardSection, filedIssuesSection } from "./catalogue";
import { claim, listReplies, type PendingReply, releaseSessionClaims, takeReply } from "./inbox";
import { IssuesProtocolHandler } from "./protocol";
import { QueueStallGuard, queueSignature, renderQueue } from "./queue";
import { ReminderBudget, renderReminder } from "./reminder";
import { renderFiledIssueInline, renderFiledIssuesFinal, renderRepliesMessage } from "./render";
import { type DeliveredReply, type IssueReplies, REPLIES_MESSAGE_TYPE, renderReplies, repliesDetails } from "./replies";
import { readIssuesSettings } from "./settings";
import {
	appendReplyHistory,
	findIssueById,
	type IssueRecord,
	type IssueSummary,
	listIssues,
	listQueuedIssues,
	moveIssue,
} from "./store";
import { type IssuesToolDetails, type IssuesToolParams, issuesTool } from "./tool";

/** Install the `issues://` handler into the host's process-global router once. */
function installIssuesScheme(log: (message: string) => void): void {
	const router = InternalUrlRouter.instance();
	if (router.getHandler("issues") instanceof IssuesProtocolHandler) return;
	try {
		router.register(new IssuesProtocolHandler());
	} catch (error) {
		log(`issues:// scheme registration failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Running background jobs or undelivered results: the session re-wakes on its own. */
function hasPendingBackgroundWork(ctx: ExtensionContext): boolean {
	const snapshot = ctx.getAsyncJobSnapshot();
	if (snapshot === null) return false;
	return snapshot.running.length > 0 || snapshot.delivery.queued > 0 || snapshot.delivery.delivering;
}

/** Group pending replies by issue, keeping the inbox's oldest-first order. */
function groupByIssue(replies: readonly PendingReply[]): Map<number, PendingReply[]> {
	const groups = new Map<number, PendingReply[]>();
	for (const reply of replies) {
		const bucket = groups.get(reply.id);
		if (bucket) bucket.push(reply);
		else groups.set(reply.id, [reply]);
	}
	return groups;
}

/**
 * Take every reply of one issue out of the inbox. A reply another session took
 * first simply yields nothing; one failure never costs the others.
 */
async function takeReplies(
	pi: ExtensionAPI,
	root: string,
	replies: readonly PendingReply[],
	sessionId: string,
): Promise<DeliveredReply[]> {
	const taken: DeliveredReply[] = [];
	for (const reply of replies) {
		try {
			const text = await takeReply(root, reply, sessionId);
			if (text !== undefined) taken.push({ text, at: reply.at });
		} catch (error) {
			pi.logger.debug("issues: failed to take a pending reply", {
				id: reply.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return taken;
}

/** Move delivered replies into their issues' `## Replies` history. */
async function recordDelivered(pi: ExtensionAPI, root: string, delivered: readonly IssueReplies[]): Promise<void> {
	for (const item of delivered) {
		for (const reply of item.replies) {
			try {
				await appendReplyHistory(root, item.record.id, reply.text, reply.at);
			} catch (error) {
				pi.logger.debug("issues: failed to record a delivered reply", {
					id: item.record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

/**
 * Mark a handed-off issue `running`: the board shows Running the moment an agent
 * takes the work, without the agent spending a read plus a write on it. Only an
 * active issue that is not already `running` is written, so a later turn end
 * writes nothing. Best effort: a failed write is logged and never blocks the
 * prompt.
 */
async function markRunning(pi: ExtensionAPI, root: string, id: number): Promise<void> {
	try {
		const record = await findIssueById(root, id);
		if (!record || record.archived || record.frontmatter.stage === "running") return;
		await moveIssue(root, id, { stage: "running" });
	} catch (error) {
		pi.logger.debug("issues: failed to mark a handed-off issue running", {
			id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Turn the replies the user typed on `omp-board` into a reminder on this prompt,
 * then record them in their issues. Nothing wakes an idle session, so the next
 * prompt of a main session in this checkout is the delivery point; the issue is
 * claimed before its replies are taken, so a parallel session never answers the
 * same reply.
 *
 * A store or inbox failure never blocks the prompt: the reminder is best-effort,
 * and a reply that could not be taken simply stays pending for the next prompt.
 */
async function deliverReplies(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	systemPrompt: string[],
): Promise<BeforeAgentStartEventResult | undefined> {
	const root = ctx.cwd;
	const sessionId = ctx.sessionManager.getSessionId();
	let pending: PendingReply[];
	try {
		pending = await listReplies(root);
	} catch (error) {
		pi.logger.debug("issues: failed to read pending replies", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (pending.length === 0) return undefined;

	const delivered: IssueReplies[] = [];
	for (const [id, replies] of groupByIssue(pending)) {
		let record: IssueRecord | undefined;
		try {
			// The claim is the lock: without it another session owns these replies.
			if (!(await claim(root, id, sessionId))) continue;
			record = await findIssueById(root, id);
		} catch (error) {
			pi.logger.debug("issues: failed to claim an issue with pending replies", {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		// The issue vanished under the reply: leave the text pending rather than drop it.
		if (!record) continue;
		await markRunning(pi, root, id);
		const taken = await takeReplies(pi, root, replies, sessionId);
		if (taken.length > 0) delivered.push({ record, replies: taken });
	}
	if (delivered.length === 0) return undefined;

	const result: BeforeAgentStartEventResult = {
		systemPrompt,
		message: {
			customType: REPLIES_MESSAGE_TYPE,
			content: renderReplies(delivered),
			display: true,
			details: repliesDetails(delivered),
		},
	};
	// The reminder is part of this prompt now; move each reply into its issue body.
	await recordDelivered(pi, root, delivered);
	return result;
}

/**
 * The turn-end queue reminder, or undefined when nothing is queued (or the stall
 * guard has spent its allowance). Claiming happens here, in the same pass that
 * hands the reminder out, so two sessions in one checkout never both take an
 * issue: the claim is the lock.
 */
async function takeQueueReminder(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	guard: QueueStallGuard,
	max: number,
): Promise<string | undefined> {
	const root = ctx.cwd;
	const sessionId = ctx.sessionManager.getSessionId();
	let queue: IssueRecord[];
	try {
		queue = await listQueuedIssues(root, sessionId);
	} catch (error) {
		pi.logger.debug("issues: failed to read the turn-end queue", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (queue.length === 0) return undefined;

	let pending: PendingReply[] = [];
	try {
		pending = await listReplies(root);
	} catch (error) {
		pi.logger.debug("issues: failed to read pending replies", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	// An unchanged queue is a stalled loop: remind a bounded number of times.
	if (!guard.take(queueSignature(queue, pending), max)) return undefined;
	const byIssue = groupByIssue(pending);

	const delivered: IssueReplies[] = [];
	for (const record of queue) {
		try {
			if (!(await claim(root, record.id, sessionId))) continue;
		} catch (error) {
			pi.logger.debug("issues: failed to claim a queued issue", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		await markRunning(pi, root, record.id);
		delivered.push({ record, replies: await takeReplies(pi, root, byIssue.get(record.id) ?? [], sessionId) });
	}
	if (delivered.length === 0) return undefined;

	await recordDelivered(pi, root, delivered);
	return renderQueue(delivered);
}

/**
 * The in-progress reminder: unchanged in spirit, it fires while an issue is still
 * `status: in-progress` and spends one unit of the per-prompt budget. Only the
 * in-progress budget resets here — clearing the queue guard's stall count when no
 * issue is in progress would let a stalled queue loop forever.
 */
async function takeInProgressReminder(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	budget: ReminderBudget,
	max: number,
): Promise<string | undefined> {
	if (budget.sent >= max) return undefined;

	let inProgress: IssueSummary[];
	try {
		inProgress = await listIssues(ctx.cwd, { status: "in-progress", archived: false });
	} catch (error) {
		pi.logger.debug("issues reminder: listIssues failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (inProgress.length === 0) {
		budget.reset();
		return undefined;
	}
	if (!budget.take(max)) return undefined;
	return renderReminder(inProgress, budget.sent, max);
}

export default function issuesPlugin(pi: ExtensionAPI): void {
	installIssuesScheme(message => pi.logger.warn(message));

	pi.registerTool(issuesTool);

	// The delivered-replies reminder is a custom message; keep its prompt header
	// compact and let the expanded view show the reminder text itself.
	pi.registerMessageRenderer(REPLIES_MESSAGE_TYPE, renderRepliesMessage);

	// A reviewer subagent files through the tool; without this its `issues add`
	// results never reach the parent's extracted-findings stream, so the task
	// card would show a review with no findings.
	subprocessToolRegistry.register<IssuesToolDetails>("issues", {
		extractData: event => {
			if (event.isError) return undefined;
			if ((event.args as Partial<IssuesToolParams> | undefined)?.op !== "add") return undefined;
			const details = event.result?.details as IssuesToolDetails | undefined;
			if (details?.op !== "add") return undefined;
			return details;
		},
		renderInline: (data, theme) => renderFiledIssueInline(data, theme),
		renderFinal: (allData, theme, expanded) => renderFiledIssuesFinal(allData, theme, expanded),
	});

	// Reminders are per prompt: a fresh prompt (or session) gets the full budget
	// back, exactly like the per-prompt cap this replaces. The queue guard resets
	// with it, so a new prompt may nudge a stalled queue once more.
	const budget = new ReminderBudget();
	const queueGuard = new QueueStallGuard();
	const resetReminders = (): void => {
		budget.reset();
		queueGuard.reset();
	};
	pi.on("input", resetReminders);
	pi.on("session_start", resetReminders);
	pi.on("session_switch", resetReminders);

	// A session that goes away must not keep issues out of every other session's
	// queue: drop its claims. Best effort — shutdown must never throw.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		try {
			await releaseSessionClaims(ctx.cwd, ctx.sessionManager.getSessionId());
		} catch (error) {
			pi.logger.debug("issues: failed to release session claims", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	pi.on("session_stop", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const settings = await readIssuesSettings(ctx.cwd);
		if (!settings.enabled) return;
		if (!settings.reminders) {
			resetReminders();
			return;
		}
		// Background work re-wakes the session with its own follow-up.
		if (hasPendingBackgroundWork(ctx)) return;

		const parts: string[] = [];
		// Queued work first: the user asked for it, so it outranks bookkeeping.
		const queuePart = await takeQueueReminder(pi, ctx, queueGuard, settings.remindersMax);
		if (queuePart !== undefined) parts.push(queuePart);
		const inProgressPart = await takeInProgressReminder(pi, ctx, budget, settings.remindersMax);
		if (inProgressPart !== undefined) parts.push(inProgressPart);
		if (parts.length === 0) return;

		return { continue: true, additionalContext: parts.join("\n\n") };
	});

	// The main agent gets the board workflow so `stage` tracks reality; agents
	// granted the `issues` tool get the catalogue in their own prompt so they
	// never re-file a settled decision or duplicate an open entry.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind === "main") {
			const settings = await readIssuesSettings(ctx.cwd);
			if (!settings.enabled) return;
			const systemPrompt = [...event.systemPrompt, boardSection];
			// Replies are queued by the board between prompts, so only a real prompt
			// delivers them — a revive re-runs the handler over an existing transcript.
			if (event.reason !== "prompt") return { systemPrompt };
			return (await deliverReplies(pi, ctx, systemPrompt)) ?? { systemPrompt };
		}
		if (ctx.agent.kind !== "sub") return;
		if (!pi.getActiveTools().includes(issuesTool.name)) return;
		const settings = await readIssuesSettings(ctx.cwd);
		if (!settings.enabled) return;
		let section: string;
		try {
			section = await filedIssuesSection(ctx.cwd);
		} catch (error) {
			pi.logger.debug("issues: failed to build the filed-issues section", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		return { systemPrompt: [...event.systemPrompt, section] };
	});
}
