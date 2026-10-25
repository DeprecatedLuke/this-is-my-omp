/**
 * Rendering contract for the `issues` tool: what the operator sees for `add`,
 * `list`, `archive`, and failures. Assertions read the rendered rows (ANSI
 * stripped) rather than the model-facing text, so a `details` regression that
 * blanks the card fails here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { renderFiledIssueInline, renderFiledIssuesFinal, renderIssuesCall, renderIssuesResult } from "../src/render";
import { type IssuesToolDetails, runIssuesOp } from "../src/tool";

const WIDTH = 100;
const theme: Theme = createTheme(getBuiltinThemes().dark!, { mode: "truecolor" });

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-render-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

function render(component: Component): string[] {
	return component.render(WIDTH).map(row => Bun.stripANSI(row));
}

/** Badges render in the theme's bracket glyphs, not ASCII `[]`. */
function badgeText(label: string): string {
	return `${theme.format.bracketLeft}${label}${theme.format.bracketRight}`;
}

async function addIssue(overrides: {
	title: string;
	category?: string;
	severity?: "low" | "medium" | "high" | "critical";
	status?: "open" | "in-progress";
	location?: string[];
	body?: string;
}): Promise<IssuesToolDetails> {
	const result = await runIssuesOp(tempDir, {
		op: "add",
		category: overrides.category ?? "security",
		title: overrides.title,
		body: overrides.body ?? "First paragraph of the finding.\n\n## Fix\n1. Do it.",
		severity: overrides.severity,
		status: overrides.status,
		location: overrides.location,
	});
	return result.details as IssuesToolDetails;
}

describe("issues render: call", () => {
	it("shows the op badge plus the subject each op names", () => {
		const add = render(
			renderIssuesCall(
				{ op: "add", category: "security", title: "Reset password leak", body: "b" },
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(add[0]).toContain("Issues");
		expect(add[0]).toContain(badgeText("add"));
		expect(add[0]).toContain("Reset password leak");

		const archive = render(renderIssuesCall({ op: "archive", id: 7 }, { expanded: false, isPartial: false }, theme));
		expect(archive[0]).toContain(badgeText("archive"));
		expect(archive[0]).toContain("#7");
	});

	it("lists filters for a list call and survives a partial (streaming) payload", () => {
		const list = render(
			renderIssuesCall(
				{ op: "list", category: "security", status: "open" },
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(list[0]).toContain(badgeText("list"));
		expect(list[0]).toContain("category=security");
		expect(list[0]).toContain("status=open");

		const partial = render(renderIssuesCall({ op: 1 }, { expanded: false, isPartial: true }, theme));
		expect(partial[0]).toContain("Issues");
	});
});

describe("issues render: add", () => {
	it("renders a card with id, badges, category, location, and the URL", async () => {
		const details = await addIssue({
			title: "Reset password leak",
			severity: "high",
			location: ["src/auth/reset.ts:10-20"],
		});
		const rows = render(
			renderIssuesResult(
				{ content: [{ type: "text", text: "Created" }], details },
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		const text = rows.join("\n");
		expect(text).toContain("#1 Reset password leak");
		expect(text).toContain(badgeText("high"));
		expect(text).toContain("src/auth/reset.ts:10-20");
		expect(text).toContain(`issues://${details.filename}`);
		// Collapsed: the body preview stays out of the card.
		expect(text).not.toContain("First paragraph of the finding.");
	});

	it("adds the body preview when expanded", async () => {
		const details = await addIssue({ title: "Wide open egress", severity: "critical" });
		const rows = render(
			renderIssuesResult(
				{ content: [{ type: "text", text: "Created" }], details },
				{ expanded: true, isPartial: false },
				theme,
			),
		);
		const text = rows.join("\n");
		expect(text).toContain("First paragraph of the finding.");
		expect(text).toContain("category");
		expect(text).toContain("security");
	});
});

describe("issues render: list", () => {
	it("sorts by severity and collapses with a counted footer", async () => {
		await addIssue({ title: "Low priority nit", severity: "low" });
		await addIssue({ title: "Medium edge case", severity: "medium" });
		await addIssue({ title: "Critical data loss", severity: "critical" });
		await addIssue({ title: "High race window", severity: "high" });
		const listed = await runIssuesOp(tempDir, { op: "list" });
		const rows = render(renderIssuesResult(listed, { expanded: false, isPartial: false }, theme));
		const text = rows.join("\n");
		expect(text).toContain("4 issues");
		const order = rows.findIndex(row => row.includes("Critical data loss"));
		const last = rows.findIndex(row => row.includes("Low priority nit"));
		expect(order).toBeLessThan(last);
		// Severity and status badges ride each row.
		expect(text).toContain(badgeText("critical"));
		expect(text).toContain(badgeText("open"));
	});

	it("counts the rows it hides when collapsed", async () => {
		for (let i = 0; i < 10; i++) {
			await addIssue({ title: `Finding number ${i}`, severity: "medium" });
		}
		const listed = await runIssuesOp(tempDir, { op: "list" });
		const collapsed = render(renderIssuesResult(listed, { expanded: false, isPartial: false }, theme)).join("\n");
		expect(collapsed).toContain("… 2 more issues");
		const expanded = render(renderIssuesResult(listed, { expanded: true, isPartial: false }, theme)).join("\n");
		expect(expanded).toContain("Finding number 0");
		expect(expanded).not.toContain("more issues");
	});

	it("says so when nothing matches", async () => {
		const listed = await runIssuesOp(tempDir, { op: "list", query: "no such thing" });
		const text = render(renderIssuesResult(listed, { expanded: false, isPartial: false }, theme)).join("\n");
		expect(text).toContain("0 issues");
		expect(text).toContain("no matching issues");
	});
});

describe("issues render: transitions and errors", () => {
	it("shows the open → fixed transition for an archive", async () => {
		const created = await addIssue({ title: "Privilege leak", severity: "high" });
		const archived = await runIssuesOp(tempDir, { op: "archive", id: created.id!, status: "fixed" });
		const text = render(renderIssuesResult(archived, { expanded: false, isPartial: false }, theme)).join("\n");
		expect(text).toContain(`#${created.id} Privilege leak`);
		expect(text).toContain(badgeText("open"));
		expect(text).toContain(badgeText("fixed"));
		expect(text).toContain("→");
	});

	it("renders an error card carrying the failure message", async () => {
		const failed = await runIssuesOp(tempDir, { op: "archive", id: 404 });
		const text = render(renderIssuesResult(failed, { expanded: false, isPartial: false }, theme)).join("\n");
		expect(text).toContain("Issue #404 not found");
	});
});

describe("issues render: subagent filed issues", () => {
	it("renders one inline row per filed issue and a counted final block", async () => {
		const first = await addIssue({ title: "Critical data loss", severity: "critical", category: "correctness" });
		const second = await addIssue({ title: "Minor nit", severity: "low", category: "style" });

		const inline = render(renderFiledIssueInline(first, theme)).join("\n");
		expect(inline).toContain("#1 Critical data loss");
		expect(inline).toContain(badgeText("critical"));

		// The parent task card only flattens `Text`/`Container` subprocess output.
		const final = render(renderFiledIssuesFinal([second, first], theme, false)).join("\n");
		expect(final).toContain("2 issues");
		expect(final).toContain("Critical data loss");
		expect(final).toContain("Minor nit");
	});
});
