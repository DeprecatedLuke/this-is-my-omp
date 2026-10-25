/**
 * `§ Filed Issues` catalogue block injected into the prompt of any subagent granted the
 * `issues` tool, so it de-duplicates against what is already catalogued instead
 * of re-filing settled decisions or open findings.
 */
import { prompt } from "@oh-my-pi/pi-utils";
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
