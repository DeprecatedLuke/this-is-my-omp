/**
 * `/knowledge` argument grammar contract: every subcommand, the `--model` /
 * `--last` / `--force` / `--sessions` flag forms, the build focus-vs-export
 * exclusion, and the usage errors a bad invocation must surface.
 */
import { describe, expect, it } from "bun:test";
import {
	completeKnowledgeArguments,
	KNOWLEDGE_USAGE,
	type KnowledgeCommand,
	parseKnowledgeCommand,
} from "../src/command-args";

function parse(args: string): KnowledgeCommand {
	const result = parseKnowledgeCommand(args);
	if (!result.ok) throw new Error(`expected a parsed command, got error: ${result.error}`);
	return result.command;
}

function parseError(args: string): string {
	const result = parseKnowledgeCommand(args);
	if (result.ok) throw new Error(`expected an error, got: ${JSON.stringify(result.command)}`);
	return result.error;
}

describe("parseKnowledgeCommand subcommands", () => {
	it("rejects an empty invocation with the usage line", () => {
		const error = parseError("");
		expect(error).toContain("No subcommand given.");
		expect(error).toContain(KNOWLEDGE_USAGE);
	});

	it("treats help and --help as help, wherever they appear", () => {
		for (const args of ["help", "--help", "save --help", "update some focus --help"]) {
			expect(parse(args)).toEqual({ kind: "help" });
		}
	});

	it("rejects unknown subcommands and unknown flags", () => {
		expect(parseError("docs")).toContain('Unknown subcommand "docs".');
		expect(parseError("build --bogus")).toContain("Unknown flag --bogus.");
		expect(parseError("update --nope=1")).toContain("Unknown flag --nope.");
	});

	it("parses every subcommand with its optional focus and model", () => {
		const cases: Array<[string, KnowledgeCommand]> = [
			["save", { kind: "save", model: undefined }],
			["save --model smol", { kind: "save", model: "smol" }],
			["build", { kind: "build", focus: undefined, model: undefined }],
			["build auth flow", { kind: "build", focus: "auth flow", model: undefined }],
			["build auth flow --model=provider/model", { kind: "build", focus: "auth flow", model: "provider/model" }],
			["update", { kind: "update", focus: undefined, model: undefined }],
			["update testing notes --model fast", { kind: "update", focus: "testing notes", model: "fast" }],
			["compact", { kind: "compact", goal: undefined, model: undefined }],
			["compact stale docs", { kind: "compact", goal: "stale docs", model: undefined }],
			["compact --model=slow stale docs", { kind: "compact", goal: "stale docs", model: "slow" }],
		];
		for (const [args, expected] of cases) {
			expect(parse(args)).toEqual(expected);
		}
	});

	it("collapses whitespace in the focus text", () => {
		expect(parse("  build   auth   flow  ")).toEqual({
			kind: "build",
			focus: "auth flow",
			model: undefined,
		});
	});
});

describe("parseKnowledgeCommand session export flags", () => {
	it("parses --sessions with --last, --force, and --model in space and = forms", () => {
		expect(parse("build --sessions")).toEqual({
			kind: "build-sessions",
			last: undefined,
			force: false,
			model: undefined,
		});
		expect(parse("build --sessions --last 72h --force --model=provider/model")).toEqual({
			kind: "build-sessions",
			last: "72h",
			force: true,
			model: "provider/model",
		});
		expect(parse("build --sessions --last=2w")).toEqual({
			kind: "build-sessions",
			last: "2w",
			force: false,
			model: undefined,
		});
	});

	it("lets --last or --force alone select the exporter", () => {
		expect(parse("build --last 30d")).toEqual({
			kind: "build-sessions",
			last: "30d",
			force: false,
			model: undefined,
		});
		expect(parse("build --force")).toEqual({
			kind: "build-sessions",
			last: undefined,
			force: true,
			model: undefined,
		});
	});

	it("refuses to combine a build focus with session export flags", () => {
		for (const args of ["build auth flow --sessions", "build --sessions auth flow", "build --force auth"]) {
			expect(parseError(args)).toContain("build --sessions takes no focus");
		}
	});
});

describe("parseKnowledgeCommand usage errors", () => {
	it("rejects arguments the subcommand does not take", () => {
		expect(parseError("save extra")).toContain("save takes no arguments.");
		expect(parseError("update --force")).toContain("update takes only an optional focus.");
		expect(parseError("update --sessions")).toContain("update takes only an optional focus.");
		expect(parseError("compact --last 1d")).toContain("compact takes only an optional goal.");
	});

	it("rejects save combined with export flags", () => {
		for (const args of ["save --sessions", "save --force", "save --last 30d"]) {
			expect(parseError(args)).toContain("save does not export sessions");
		}
	});

	it("rejects flags with missing or empty values", () => {
		const cases = [
			["build --model", "--model needs a value."],
			["build --model --force", "--model needs a value."],
			["build --model=", "--model needs a value."],
			["build --last", "--last needs a value."],
			["build --last=", "--last needs a value."],
			["save --model", "--model needs a value."],
		] as const;
		for (const [args, expected] of cases) {
			const error = parseError(args);
			expect(error).toContain(expected);
			expect(error).toContain(KNOWLEDGE_USAGE);
		}
	});
});

describe("completeKnowledgeArguments", () => {
	it("completes the subcommands in declaration order", () => {
		const items = completeKnowledgeArguments("");
		expect(items?.map(item => item.value)).toEqual(["save", "build", "update", "compact"]);
		expect(items?.every(item => (item.description ?? "").length > 0)).toBe(true);
	});

	it("filters subcommands by the typed prefix", () => {
		expect(completeKnowledgeArguments("b")?.map(item => item.value)).toEqual(["build"]);
		expect(completeKnowledgeArguments("sa")?.map(item => item.value)).toEqual(["save"]);
		expect(completeKnowledgeArguments("co")?.map(item => item.value)).toEqual(["compact"]);
	});

	it("offers flags once arguments have started", () => {
		expect(completeKnowledgeArguments("build ")?.map(item => item.value)).toEqual([
			"--sessions",
			"--last",
			"--force",
			"--model",
		]);
		expect(completeKnowledgeArguments("build --s")?.map(item => item.value)).toEqual(["--sessions"]);
		expect(completeKnowledgeArguments("update --mo")?.map(item => item.value)).toEqual(["--model"]);
	});

	it("returns null when nothing matches", () => {
		expect(completeKnowledgeArguments("zzz")).toBeNull();
		expect(completeKnowledgeArguments("build --zzz")).toBeNull();
	});
});
