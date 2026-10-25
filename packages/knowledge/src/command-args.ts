/**
 * `/knowledge` argument grammar, kept pure so it is testable without a session.
 *
 * ```
 * /knowledge save [--model <role|provider/model>]
 * /knowledge build [<focus>] [--model ...]
 * /knowledge build --sessions [--last <30d|72h|2w|all>] [--force] [--model ...]
 * /knowledge update [<focus>] [--model ...]
 * /knowledge compact [<goal>] [--model ...]
 * ```
 */
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

export type KnowledgeSubcommand = "save" | "build" | "update" | "compact";

/** `--sessions` (or a `--last`/`--force` flag) selects the saved-session exporter. */
export interface BuildSessionsCommand {
	kind: "build-sessions";
	last?: string;
	force: boolean;
	model?: string;
}

export type KnowledgeCommand =
	| { kind: "save"; model?: string }
	| { kind: "build"; focus?: string; model?: string }
	| BuildSessionsCommand
	| { kind: "update"; focus?: string; model?: string }
	| { kind: "compact"; goal?: string; model?: string }
	| { kind: "help" };

export type KnowledgeCommandParse = { ok: true; command: KnowledgeCommand } | { ok: false; error: string };

export const KNOWLEDGE_USAGE =
	"Usage: /knowledge <save|build|update|compact> [args] — build: [focus] | --sessions [--last 30d] [--force]";

const SUBCOMMANDS: readonly KnowledgeSubcommand[] = ["save", "build", "update", "compact"];

interface ParsedFlags {
	words: string[];
	last?: string;
	force: boolean;
	sessions: boolean;
	model?: string;
}

function parseFlags(tokens: readonly string[]): { ok: true; flags: ParsedFlags } | { ok: false; error: string } {
	const flags: ParsedFlags = { words: [], force: false, sessions: false };
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token.startsWith("--")) {
			flags.words.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
		const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
		switch (name) {
			case "force":
				flags.force = true;
				break;
			case "sessions":
				flags.sessions = true;
				break;
			case "last":
			case "model": {
				const value = inlineValue ?? tokens[++index];
				if (value === undefined || value.length === 0 || value.startsWith("--")) {
					return { ok: false, error: `--${name} needs a value. ${KNOWLEDGE_USAGE}` };
				}
				if (name === "last") flags.last = value;
				else flags.model = value;
				break;
			}
			case "help":
				return { ok: true, flags: { ...flags, words: ["--help"] } };
			default:
				return { ok: false, error: `Unknown flag --${name}. ${KNOWLEDGE_USAGE}` };
		}
	}
	return { ok: true, flags };
}

/** Parse the text after `/knowledge`. */
export function parseKnowledgeCommand(args: string): KnowledgeCommandParse {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter(token => token.length > 0);
	if (tokens.length === 0) return { ok: false, error: `No subcommand given. ${KNOWLEDGE_USAGE}` };
	const [head, ...rest] = tokens;
	if (head === "--help" || head === "help") return { ok: true, command: { kind: "help" } };
	if (!isSubcommand(head)) {
		return { ok: false, error: `Unknown subcommand "${head}". ${KNOWLEDGE_USAGE}` };
	}
	const parsed = parseFlags(rest);
	if (!parsed.ok) return parsed;
	const { flags } = parsed;
	if (flags.words[0] === "--help") return { ok: true, command: { kind: "help" } };
	const text = flags.words.join(" ").trim();
	const focus = text.length > 0 ? text : undefined;

	if (head === "save") {
		if (focus !== undefined) return { ok: false, error: `save takes no arguments. ${KNOWLEDGE_USAGE}` };
		if (flags.sessions || flags.force || flags.last !== undefined) {
			return { ok: false, error: `save does not export sessions; use /knowledge build --sessions.` };
		}
		return { ok: true, command: { kind: "save", model: flags.model } };
	}
	if (head === "update") {
		if (flags.sessions || flags.force || flags.last !== undefined) {
			return { ok: false, error: `update takes only an optional focus. ${KNOWLEDGE_USAGE}` };
		}
		return { ok: true, command: { kind: "update", focus, model: flags.model } };
	}
	if (head === "compact") {
		if (flags.sessions || flags.force || flags.last !== undefined) {
			return { ok: false, error: `compact takes only an optional goal. ${KNOWLEDGE_USAGE}` };
		}
		return { ok: true, command: { kind: "compact", goal: focus, model: flags.model } };
	}
	// build: a bare arg is a focus for repository exploration; session-export
	// flags select the exporter instead, and the two cannot be combined.
	const wantsExport = flags.sessions || flags.force || flags.last !== undefined;
	if (wantsExport && focus !== undefined) {
		return { ok: false, error: `build --sessions takes no focus; use /knowledge build <focus> for exploration.` };
	}
	if (wantsExport) {
		return {
			ok: true,
			command: { kind: "build-sessions", last: flags.last, force: flags.force, model: flags.model },
		};
	}
	return { ok: true, command: { kind: "build", focus, model: flags.model } };
}

function isSubcommand(value: string): value is KnowledgeSubcommand {
	return (SUBCOMMANDS as readonly string[]).includes(value);
}

const SUBCOMMAND_DESCRIPTIONS: Record<KnowledgeSubcommand, string> = {
	save: "Distill this session into .omp/knowledge and commit it",
	build: "Explore the project and author the knowledge base (or --sessions to backfill from saved sessions)",
	update: "Verify every note against the repo and fix what is stale",
	compact: "Prune duplicates and outdated notes, or pursue a goal",
};

const FLAG_ITEMS: readonly AutocompleteItem[] = [
	{ value: "--sessions", label: "--sessions", description: "build: backfill from saved sessions" },
	{ value: "--last", label: "--last", description: "build --sessions: 30d, 72h, 2w, or all" },
	{ value: "--force", label: "--force", description: "build --sessions: re-export already exported sessions" },
	{ value: "--model", label: "--model", description: "Model role or provider/model for the pass" },
];

/** Editor completions for the argument text after `/knowledge `. */
export function completeKnowledgeArguments(prefix: string): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart();
	if (!trimmed.includes(" ")) {
		const items = SUBCOMMANDS.filter(name => name.startsWith(trimmed)).map(name => ({
			value: name,
			label: name,
			description: SUBCOMMAND_DESCRIPTIONS[name],
		}));
		return items.length > 0 ? items : null;
	}
	const items = FLAG_ITEMS.filter(item => item.value.startsWith(trimmed.split(/\s+/).at(-1) ?? ""));
	return items.length > 0 ? items : null;
}
