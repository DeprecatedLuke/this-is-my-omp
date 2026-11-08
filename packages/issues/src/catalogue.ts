/**
 * Issue prompt sections. `§ Filed Issues` is injected into the prompt of any subagent
 * granted the `issues` tool, so it de-duplicates against what is already catalogued
 * instead of re-filing settled decisions or open findings. `§ Issue Board` goes to
 * the main agent, so it keeps `stage` current for `omp-board`.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import boardTemplate from "./prompts/board.md" with { type: "text" };
import filedIssuesTemplate from "./prompts/filed-issues.md" with { type: "text" };
import { listIssues, renderIssueListing } from "./store";

/** The active + archived catalogue, or a placeholder when nothing is filed yet. */
export async function filedIssuesCatalogue(cwd: string): Promise<string> {
	const summaries = await listIssues(cwd);
	if (summaries.length === 0) return "_No issues filed yet._";
	return renderIssueListing(summaries, {
		title: "",
		emptyText: "",
		group: true,
		showArchived: true,
	}).trimStart();
}

/** The whole prompt section for `cwd`, ready to append to a system prompt. */
export async function filedIssuesSection(cwd: string): Promise<string> {
	return prompt.render(filedIssuesTemplate, { listing: await filedIssuesCatalogue(cwd) });
}

/** `§ Issue Board`: the main agent's `stage` workflow for `omp-board`. Static, so the prompt prefix stays cacheable. */
export const boardSection: string = prompt.render(boardTemplate, {});
