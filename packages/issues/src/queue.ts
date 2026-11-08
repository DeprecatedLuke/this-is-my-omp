/**
 * Turn-end queue: the issues the user queued for an agent on `omp-board`.
 *
 * A queued issue keeps the session going instead of letting it stop silently: the
 * `session_stop` handler hands back a reminder and one continuation turn. The
 * loop is bounded by {@link QueueStallGuard}, so an agent that ignores the queue
 * is reminded `remindersMax` times and then left alone — and by `needs-you`,
 * which is how the agent says it needs the user and ends the loop for an issue.
 *
 * Only the bookkeeping and rendering live here so the event wiring in `index.ts`
 * stays a thin adapter.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { PendingReply } from "./inbox";
import queueTemplate from "./prompts/queue.md" with { type: "text" };
import type { IssueReplies } from "./replies";
import type { IssueRecord } from "./store";

/**
 * Stall guard for the turn-end loop.
 *
 * The signature (see {@link queueSignature}) only moves on progress the loop is
 * about — an issue joining or leaving the queue, a stage or status change, a new
 * board reply — and that restores the full allowance. Body edits do not count: a
 * working agent that rewrites its issue every turn without handing it back must
 * not keep the loop alive forever. An unchanged signature counts one stall per
 * reminder.
 */
export class QueueStallGuard {
	#signature: string | undefined;
	#stalls = 0;

	reset(): void {
		this.#signature = undefined;
		this.#stalls = 0;
	}

	/** Count a stall when the queue is unchanged since the last reminder; true while still worth reminding. */
	take(signature: string, max: number): boolean {
		if (this.#signature === signature) {
			this.#stalls += 1;
		} else {
			this.#signature = signature;
			this.#stalls = 0;
		}
		return this.#stalls < max;
	}
}

/**
 * Signature of a queue: sorted `id:stage:status` entries plus the pending board
 * replies for queued issues. `updated` is deliberately left out (see
 * {@link QueueStallGuard}).
 */
export function queueSignature(queue: readonly IssueRecord[], pending: readonly PendingReply[]): string {
	const ids = new Set(queue.map(record => record.id));
	const issues = queue.map(
		record => `${record.id}:${record.frontmatter.stage ?? ""}:${record.frontmatter.status ?? ""}`,
	);
	const replies = pending.filter(reply => ids.has(reply.id)).map(reply => `${reply.id}@${reply.file}`);
	return [...issues, ...replies].sort().join("|");
}

/** Model-visible reminder listing the queued issues, with each pending reply verbatim. */
export function renderQueue(queue: readonly IssueReplies[]): string {
	return prompt.render(queueTemplate, {
		count: String(queue.length),
		issues: queue
			.map(item => {
				const head = `### issues://${item.record.id} — ${item.record.frontmatter.title}`;
				const replies = item.replies.map(reply => reply.text).join("\n\n");
				return replies.length > 0 ? `${head}\n${replies}` : `${head}\nNo reply — start it.`;
			})
			.join("\n\n"),
	});
}
