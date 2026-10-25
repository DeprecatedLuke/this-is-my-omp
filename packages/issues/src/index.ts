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
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";
import { filedIssuesSection } from "./catalogue";
import { IssuesProtocolHandler } from "./protocol";
import { ReminderBudget, renderReminder } from "./reminder";
import { renderFiledIssueInline, renderFiledIssuesFinal } from "./render";
import { readIssuesSettings } from "./settings";
import { type IssueSummary, listIssues } from "./store";
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

export default function issuesPlugin(pi: ExtensionAPI): void {
	installIssuesScheme(message => pi.logger.warn(message));

	pi.registerTool(issuesTool);

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
	// back, exactly like the per-prompt cap this replaces.
	const budget = new ReminderBudget();
	const resetReminders = (): void => budget.reset();
	pi.on("input", resetReminders);
	pi.on("session_start", resetReminders);
	pi.on("session_switch", resetReminders);

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
		if (budget.sent >= settings.remindersMax) return;

		let inProgress: IssueSummary[];
		try {
			inProgress = await listIssues(ctx.cwd, { status: "in-progress", archived: false });
		} catch (error) {
			pi.logger.debug("issues reminder: listIssues failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (inProgress.length === 0) {
			resetReminders();
			return;
		}
		if (!budget.take(settings.remindersMax)) return;

		return {
			continue: true,
			additionalContext: renderReminder(inProgress, budget.sent, settings.remindersMax),
		};
	});

	// Agents granted the `issues` tool get the catalogue in their own prompt so
	// they never re-file a settled decision or duplicate an open entry.
	pi.on("before_agent_start", async (event, ctx) => {
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
