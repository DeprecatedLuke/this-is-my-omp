import { beforeAll, describe, expect, test } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import {
	type CardSpec,
	collapsedList,
	errorCard,
	headerLine,
	keyValueRows,
	pathLabel,
	type RenderOptions,
	sanitize,
	severityTone,
	statusTone,
	toolCard,
	toolHeader,
} from "@this-is-my-omp/render";

let uiTheme: themeModule.Theme;

beforeAll(async () => {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const loaded = await themeModule.getThemeByName("dark");
	if (!loaded) throw new Error("dark test theme is unavailable");
	uiTheme = loaded;
});

const WIDTHS = [16, 24, 40, 80];

/** Terminal columns a row occupies, ignoring SGR styling. */
function cells(row: string): number {
	return Bun.stringWidth(Bun.stripANSI(row));
}

function renderLines(component: { render(width: number): readonly string[] }, width: number): string[] {
	return component.render(width).map(row => row);
}

const sampleCard: CardSpec = {
	header: {
		tool: "Issues",
		icon: "success",
		title: "open issues in packages/render",
		badges: [
			{ text: "high", tone: "error" },
			{ text: "3", tone: "muted" },
		],
		meta: ["12 total", "2 files"],
	},
	body: [
		"high   Renderer truncates ANSI-styled rows".padEnd(80, " "),
		"\tmedium\tTabbed body row that must never leak a tab",
		"\x1b[31mred\x1b[0m control\x07chars\x1b]0;bell\x07",
	],
	footer: "2 files · 12 issues · workspace ~/projects/example-workspace/packages/demo",
};

describe("width truncation", () => {
	test("toolCard rows never exceed the render width", () => {
		for (const width of WIDTHS) {
			for (const row of renderLines(toolCard(uiTheme, sampleCard), width)) {
				expect(cells(row)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("headerLine truncates to the render width", () => {
		const header = headerLine(uiTheme, sampleCard.header);
		for (const width of WIDTHS) {
			const rows = renderLines(header, width);
			expect(rows).toHaveLength(1);
			expect(cells(rows[0]!)).toBeLessThanOrEqual(width);
		}
	});

	test("errorCard rows never exceed the render width", () => {
		const card = errorCard(uiTheme, "Knowledge", `build failed: ${"stack ".repeat(80)}`);
		for (const width of WIDTHS) {
			for (const row of renderLines(card, width)) expect(cells(row)).toBeLessThanOrEqual(width);
		}
	});
});

describe("sanitization", () => {
	test("sanitize expands tabs and drops ANSI/control bytes", () => {
		const cleaned = sanitize("\x1b[31mred\x1b[0m\ttab\x07\x00");
		expect(cleaned).not.toContain("\t");
		expect(cleaned).not.toContain("\x1b");
		expect(cleaned).not.toContain("\x07");
		expect(cleaned).toContain("red");
	});

	test("cards, lists and rows never leak tabs or control characters", () => {
		const rows = [
			...renderLines(toolCard(uiTheme, sampleCard), 80),
			...collapsedList(["\ta", "b\tb", "c\x07"], item => item, {
				expanded: true,
				noun: "entry",
				theme: uiTheme,
			}),
			...keyValueRows(uiTheme, [["ke\ty", "va\x07lue"]]),
		];
		for (const row of rows) {
			expect(row).not.toContain("\t");
			expect(row).not.toContain("\x07");
		}
	});

	test("header text collapses embedded newlines onto one row", () => {
		const header = toolHeader(uiTheme, { tool: "Issues", title: "multi\nline\r\ntitle" });
		expect(Bun.stripANSI(header)).not.toContain("\n");
	});

	test("pathLabel shortens the home directory", () => {
		const home = process.env.HOME;
		if (!home) return;
		expect(pathLabel(`${home}/projects/x.md`)).toBe("~/projects/x.md");
	});
});

describe("collapsedList", () => {
	const items = Array.from({ length: 10 }, (_, index) => `item ${index + 1}`);

	test("collapsed renders the limit plus a footer counting the hidden items", () => {
		const rows = collapsedList(items, item => item, { expanded: false, limit: 3, noun: "issue", theme: uiTheme });
		expect(rows).toHaveLength(4);
		expect(Bun.stripANSI(rows[3]!)).toContain("… 7 more issues");
		for (const row of rows.slice(0, 3)) expect(Bun.stripANSI(row)).toContain("item ");
	});

	test("expanded renders every item with no footer", () => {
		const rows = collapsedList(items, item => item, { expanded: true, limit: 3, noun: "issue", theme: uiTheme });
		expect(rows).toHaveLength(items.length);
		expect(Bun.stripANSI(rows.join("\n"))).not.toContain("more issues");
	});

	test("a list within the limit has no footer and closes its branch", () => {
		const rows = collapsedList(["only"], item => item, { expanded: false, limit: 3, noun: "issue", theme: uiTheme });
		expect(rows).toHaveLength(1);
		expect(Bun.stripANSI(rows[0]!)).toContain(uiTheme.tree.last);
	});

	test("multi-line items continue under the branch gutter", () => {
		const rows = collapsedList(["first\nsecond"], item => item, {
			expanded: false,
			noun: "entry",
			theme: uiTheme,
		});
		expect(rows).toHaveLength(2);
		expect(Bun.stripANSI(rows[1]!)).toContain("second");
	});
});

describe("tones", () => {
	test("severity maps to the built-in finding colors", () => {
		expect(severityTone("critical")).toBe("error");
		expect(severityTone("High")).toBe("error");
		expect(severityTone("medium")).toBe("warning");
		expect(severityTone("low")).toBe("muted");
		expect(severityTone("info")).toBe("dim");
	});

	test("status maps lifecycle states", () => {
		expect(statusTone("open")).toBe("accent");
		expect(statusTone("in_progress")).toBe("warning");
		expect(statusTone("closed")).toBe("success");
		expect(statusTone("committed")).toBe("success");
		expect(statusTone("failed")).toBe("error");
		expect(statusTone("skipped")).toBe("dim");
		expect(statusTone("something else")).toBe("muted");
	});
});

describe("partial rendering", () => {
	test("a header-only card renders without body or footer", () => {
		const rows = renderLines(toolCard(uiTheme, { header: { tool: "Issues" } }), 30);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(Bun.stripANSI(rows[0]!)).toContain("Issues");
	});

	test("headerLine renders a running spinner without a frame index", () => {
		const options: RenderOptions = { expanded: false, isPartial: true };
		const header = headerLine(uiTheme, { tool: "Checkpoint", icon: "running", meta: [String(options.isPartial)] });
		expect(Bun.stripANSI(header.render(60)[0]!)).toContain("Checkpoint");
	});
});
