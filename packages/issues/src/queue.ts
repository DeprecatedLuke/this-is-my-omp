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
import queueTemplate from "./prompts/queue.md" with { type: "text" };
import type { IssueReplies } from "./replies";
import type { IssueRecord } from "./store";

/**
 * Stall guard for the turn-end loop.
 *
 * The signature is the sorted `id:updated` set of the queue, so any real progress
 * — a stage change, a delivered reply, an archive — changes it and restores the
 * full allowance. An unchanged queue counts one stall per reminder.
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

/** Signature of a queue: sorted `id:updated` pairs. */
export function queueSignature(queue: readonly IssueRecord[]): string {
	return queue
		.map(record => `${record.id}:${record.frontmatter.updated ?? ""}`)
		.sort()
		.join("|");
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
