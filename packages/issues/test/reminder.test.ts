/**
 * End-of-turn reminder contract: a per-prompt budget capped by
 * `issues.reminders.max`, and the text the model sees (which issues, and how
 * many reminders have already been spent).
 */
import { describe, expect, it } from "bun:test";
import { ReminderBudget, renderReminder } from "../src/reminder";
import type { IssueSummary } from "../src/store";

const inProgress: IssueSummary[] = [
	{
		id: 4,
		category: "security",
		title: "Rotate leaked token",
		severity: "high",
		status: "in-progress",
		archived: false,
		filename: "4-rotate-leaked-token.md",
	},
	{
		id: 7,
		category: "correctness",
		title: "Handle empty batch",
		severity: "medium",
		status: "in-progress",
		archived: false,
		filename: "7-handle-empty-batch.md",
	},
];

describe("reminder budget", () => {
	it("spends one reminder per call and refuses past the cap", () => {
		const budget = new ReminderBudget();
		expect(budget.sent).toBe(0);
		expect(budget.take(2)).toBe(true);
		expect(budget.take(2)).toBe(true);
		expect(budget.sent).toBe(2);
		expect(budget.take(2)).toBe(false);
		expect(budget.sent).toBe(2);
	});

	it("restores the full allowance on a new prompt", () => {
		const budget = new ReminderBudget();
		budget.take(1);
		expect(budget.take(1)).toBe(false);
		budget.reset();
		expect(budget.sent).toBe(0);
		expect(budget.take(1)).toBe(true);
	});
});

describe("reminder text", () => {
	it("names each in-progress issue with its category and counts the attempt", () => {
		const text = renderReminder(inProgress, 2, 3);
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("2 issue(s) still marked in-progress");
		expect(text).toContain("- #4 Rotate leaked token (security)");
		expect(text).toContain("- #7 Handle empty batch (correctness)");
		expect(text).toContain("(Reminder 2/3)");
		expect(text.trimEnd().endsWith("</system-reminder>")).toBe(true);
	});
});
