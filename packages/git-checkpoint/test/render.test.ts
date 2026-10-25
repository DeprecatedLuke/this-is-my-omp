/**
 * Rendering contract: the call row names the stage, the listing card shows every
 * dirty repo with its changed-file count (file names when expanded), and the commit
 * card reports each repo's status, sha, file count, subject, or failure detail.
 */
import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { type Component, sanitize } from "@this-is-my-omp/render";
import type { CheckpointRepoEntry, DirtyRepo } from "../src/checkpoint";
import { renderCheckpointCall, renderCheckpointResult } from "../src/render";
import type { GitCheckpointToolDetails } from "../src/tool";

const theme = loadThemeSync("dark");

/** One rendered frame as plain text, so assertions read like the terminal output. */
function text(component: Component, width = 100): string {
	// `sanitize` strips the SGR styling the theme emits and keeps line structure.
	return sanitize(component.render(width).join("\n"));
}

const DIRTY: DirtyRepo[] = [
	{ repoPath: "/work/app", label: ".", changedFiles: 2, files: ["src/index.ts", "README.md"] },
	{ repoPath: "/work/app/packages/lib", label: "packages/lib", changedFiles: 1, files: ["lib.ts"] },
];

function result(details: GitCheckpointToolDetails, isError = false): AgentToolResult<GitCheckpointToolDetails> {
	return { content: [{ type: "text", text: "ignored by the renderer" }], details, ...(isError ? { isError } : {}) };
}

describe("git_checkpoint rendering", () => {
	it("call row names the stage: list when no repos, commit plus the names otherwise", () => {
		const listing = text(renderCheckpointCall({}, { expanded: false, isPartial: false }, theme));
		const committing = text(
			renderCheckpointCall({ repos: ["packages/lib"] }, { expanded: false, isPartial: false }, theme),
		);

		expect(listing).toContain("git_checkpoint");
		expect(listing).toContain("list");
		expect(listing).toContain("list dirty repos");
		expect(committing).toContain("commit");
		expect(committing).toContain("packages/lib");
	});

	it("listing card counts changed files per repo and names them only when expanded", () => {
		const details: GitCheckpointToolDetails = { stage: "listed", dirty: DIRTY };

		const collapsed = text(renderCheckpointResult(result(details), { expanded: false, isPartial: false }, theme));
		const expanded = text(renderCheckpointResult(result(details), { expanded: true, isPartial: false }, theme));

		expect(collapsed).toContain("2 repos with changes");
		expect(collapsed).toContain("list");
		expect(collapsed).toContain(".");
		expect(collapsed).toContain("2 files");
		expect(collapsed).toContain("packages/lib");
		expect(collapsed).toContain("1 file");
		expect(collapsed).toContain("nothing was committed");
		expect(collapsed).not.toContain("src/index.ts");
		expect(expanded).toContain("src/index.ts");
		expect(expanded).toContain("README.md");
		expect(expanded).toContain("lib.ts");
	});

	it("commit card reports status, sha, file count, subject, and failure detail", () => {
		const entries: CheckpointRepoEntry[] = [
			{
				repoPath: "/work/app",
				label: ".",
				status: "committed",
				sha: "1a2b3c4",
				filesChanged: 2,
				message: "feat: wire the checkpoint tool\n\nbody line",
			},
			{
				repoPath: "/work/app/packages/lib",
				label: "packages/lib",
				status: "skipped",
				filesChanged: 0,
				reason: "no-changes",
			},
			{
				repoPath: "/work/app/packages/broken",
				label: "packages/broken",
				status: "failed",
				filesChanged: 0,
				error: "Could not generate a commit message.",
			},
		];

		const collapsed = text(
			renderCheckpointResult(
				result({ stage: "committed", dirty: DIRTY, entries }, true),
				{
					expanded: false,
					isPartial: false,
				},
				theme,
			),
		);

		expect(collapsed).toContain("3 repos");
		expect(collapsed).toContain("committed");
		expect(collapsed).toContain("1a2b3c4");
		expect(collapsed).toContain("2 files");
		expect(collapsed).toContain("feat: wire the checkpoint tool");
		expect(collapsed).not.toContain("body line");
		expect(collapsed).toContain("skipped");
		expect(collapsed).toContain("packages/broken");
		expect(collapsed).toContain("Could not generate a commit message.");
		expect(collapsed).toContain("1 commit");
		expect(collapsed).toContain("1 skipped");
		expect(collapsed).toContain("1 failed");
		expect(collapsed).toContain("partial checkpoint");
	});

	it("unmatched card names the unknown repos and the ones that could be named", () => {
		const details: GitCheckpointToolDetails = { stage: "unmatched", dirty: DIRTY, unmatched: ["nope"] };

		const rendered = text(
			renderCheckpointResult(result(details, true), { expanded: false, isPartial: false }, theme),
		);

		expect(rendered).toContain("No dirty repo matches: nope");
		expect(rendered).toContain("unmatched");
		expect(rendered).toContain("packages/lib");
		expect(rendered).toContain("nothing was committed");
	});

	it("clean workspace renders without a body row per repo", () => {
		const rendered = text(
			renderCheckpointResult(result({ stage: "clean", dirty: [] }), { expanded: false, isPartial: false }, theme),
		);

		expect(rendered).toContain("clean");
		expect(rendered).toContain("Nothing to commit");
	});

	it("renders a streaming call and a details-less result without throwing", () => {
		const call = text(
			renderCheckpointCall({ repos: 1 }, { expanded: false, isPartial: true, spinnerFrame: 3 }, theme),
		);
		const pending = text(
			renderCheckpointResult(
				{ content: [{ type: "text", text: "Detected repos with changes:" }] },
				{ expanded: false, isPartial: true },
				theme,
			),
		);

		expect(call).toContain("list dirty repos");
		expect(pending).toContain("Detected repos with changes:");
	});
});
