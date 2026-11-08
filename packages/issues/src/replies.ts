/**
 * Delivery of `omp-board` user replies.
 *
 * A reply is typed on the board and parked in the local inbox — never in the
 * git-tracked issue — and nothing wakes an idle session. The next prompt of a
 * main session in this checkout turns the pending replies into a
 * `<system-reminder>` custom message, and each one is recorded in the issue body
 * once it has been handed to the model. Only the rendering lives here so the
 * event wiring in `index.ts` stays a thin adapter.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import repliesTemplate from "./prompts/replies.md" with { type: "text" };
import type { IssueRecord } from "./store";

/** Custom message type of the reminder that carries queued replies. */
export const REPLIES_MESSAGE_TYPE = "omp-issues/replies";

/** One reply text taken out of the inbox, with the time it was queued. */
export interface DeliveredReply {
	text: string;
	at: string;
}

/** One issue whose replies a reminder delivers, with the texts taken for it. */
export interface IssueReplies {
	record: IssueRecord;
	replies: DeliveredReply[];
}

/** One delivered issue, as the TUI card lists it. */
export interface ReplySummary {
	id: number;
	title: string;
	url: string;
}

/** Details carried by the reminder message so the TUI renders from the store, not the prompt text. */
export interface RepliesDetails {
	replies: ReplySummary[];
}

/** Model-visible reminder listing every delivered reply with its issue and verbatim text. */
export function renderReplies(items: readonly IssueReplies[]): string {
	return prompt.render(repliesTemplate, {
		count: String(items.length),
		replies: items
			.flatMap(item =>
				item.replies.map(
					reply => `### issues://${item.record.id} — ${item.record.frontmatter.title}\n${reply.text}`,
				),
			)
			.join("\n\n"),
	});
}

/** Message details for the TUI card. */
export function repliesDetails(items: readonly IssueReplies[]): RepliesDetails {
	return {
		replies: items.map(item => ({
			id: item.record.id,
			title: item.record.frontmatter.title,
			url: `issues://${item.record.id}`,
		})),
	};
}
