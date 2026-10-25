/**
 * End-of-turn reminder for issues still marked `in-progress`.
 *
 * The budget is per prompt: a fresh prompt restores the full allowance, and the
 * cap keeps an unchanged issue from looping the session forever. Only the
 * bookkeeping lives here so the event wiring in `index.ts` stays a thin adapter.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import reminderTemplate from "./prompts/reminder.md" with { type: "text" };
import type { IssueSummary } from "./store";

/** How many reminders this prompt has already spent. */
export class ReminderBudget {
	#sent = 0;

	reset(): void {
		this.#sent = 0;
	}

	get sent(): number {
		return this.#sent;
	}

	/** Spend one reminder, or refuse when the prompt's allowance is gone. */
	take(max: number): boolean {
		if (this.#sent >= max) return false;
		this.#sent += 1;
		return true;
	}
}

/** Model-visible reminder text for the issues still in progress. */
export function renderReminder(inProgress: readonly IssueSummary[], attempt: number, max: number): string {
	return prompt.render(reminderTemplate, {
		count: String(inProgress.length),
		issues: inProgress.map(issue => `- #${issue.id} ${issue.title} (${issue.category})`).join("\n"),
		attempt: String(attempt),
		max: String(max),
	});
}
