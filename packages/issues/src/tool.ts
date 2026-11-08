/**
 * `issues` tool — add, archive, unarchive, stage, and list project-local issues
 * persisted under `<cwd>/.omp/issues/`. URLs (`issues://`) cover the read side;
 * this tool owns the write side so id allocation, slug derivation, and archive
 * moves stay in one place.
 *
 * When the reviewer subagent calls `op: add`, the subprocess tool registry
 * extracts each event into the parent's findings stream so the parent UI
 * can render the issues filed by a review without bespoke wiring per
 * caller.
 */

import * as z from "@oh-my-pi/omptype/zod";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { boardOwner, claim, claimIsStale, claimOwner, touchPresence } from "./inbox";
import issuesDescription from "./prompts/tool.md" with { type: "text" };
import { renderIssuesCall, renderIssuesResult } from "./render";
import { readIssuesSettings } from "./settings";
import type { AddIssueInput, IssueRecord, IssueSeverity, IssueStage, IssueStatus, IssueSummary } from "./store";
import {
	addIssue,
	archiveIssue,
	findIssueById,
	ISSUE_STAGES,
	listIssues,
	moveIssue,
	normalizeCategory,
	renderIssueListing,
	unarchiveIssue,
} from "./store";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const statusEnum = z.enum(["open", "in-progress", "fixed", "wontfix", "duplicate"]);

const addParams = z.object({
	op: z.literal("add"),
	category: z.string().min(1).describe("kebab-case bucket; e.g. `security`, `data-correctness`"),
	title: z.string().min(1).describe("short imperative phrase, ~5-10 words"),
	body: z.string().min(1).describe("markdown body; describe the bug, then add `## Fix` steps"),
	severity: severityEnum.optional(),
	status: statusEnum.optional(),
	report: z
		.string()
		.describe("report this issue is written up in: `report://<project>/<slug>` or an `https://` URL")
		.optional(),
	location: z.array(z.string()).describe("`path` or `path:line[-line]` references").optional(),
	extra: z.record(z.string(), z.unknown()).describe("extra frontmatter fields").optional(),
});

const archiveParams = z.object({
	op: z.literal("archive"),
	id: z.number().int().positive(),
	reason: z.string().optional(),
	status: statusEnum.describe("status to record on archive; default `fixed`").optional(),
});

const unarchiveParams = z.object({
	op: z.literal("unarchive"),
	id: z.number().int().positive(),
	status: statusEnum.describe("status to record on restore; default `open`").optional(),
});

const stageParams = z.object({
	op: z.literal("stage"),
	id: z.number().int().positive(),
	stage: z
		.enum([...ISSUE_STAGES, "none"])
		.describe("board state to set; `none` clears it, `running` while you work, `needs-you` to hand it back"),
});

const listParams = z.object({
	op: z.literal("list"),
	category: z.string().optional(),
	archived: z.boolean().describe("true → archived only; false → active only; omit → both").optional(),
	severity: severityEnum.optional(),
	status: statusEnum.optional(),
	query: z.string().describe("substring filter against title/body/frontmatter").optional(),
	limit: z.number().int().positive().optional(),
});

const joinParams = z.object({
	op: z.literal("join"),
});

const issuesSchema = z.union([addParams, archiveParams, unarchiveParams, stageParams, listParams, joinParams]);
export type IssuesToolParams = z.infer<typeof issuesSchema>;

/** Filters a `list` call ran with, echoed in `details` so renderers never parse text. */
export interface IssueFilters {
	category?: string;
	archived?: boolean;
	severity?: IssueSeverity;
	status?: IssueStatus;
	query?: string;
	limit?: number;
}

export interface IssuesToolDetails {
	op: IssuesToolParams["op"];
	id?: number;
	category?: string;
	filename?: string;
	url?: string;
	archived?: boolean;
	title?: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	/** Status the file carried before an `archive`/`unarchive` moved it. */
	previousStatus?: IssueStatus;
	/** Board stage the file carries after the op. */
	stage?: IssueStage;
	/** Stage the file carried before a `stage` op; absent when it had none. */
	previousStage?: IssueStage;
	/** Archive state before an `archive`/`unarchive`, for the transition row. */
	previousArchived?: boolean;
	/** `archive`/`unarchive`/`stage` found the issue already in the requested state. */
	unchanged?: boolean;
	listing?: IssueSummary[];
	/** Filters the `list` op ran with. */
	filters?: IssueFilters;
	/** First paragraph of the body, capped, for parent rendering. */
	bodyPreview?: string;
	/** First entry from `location[]`, captured for combined verdict views. */
	location?: string;
	/** Optional confidence (0..1), echoed back when the agent passes it. */
	confidence?: number;
	/** Failure message when the op reported an error instead of throwing. */
	error?: string;
	/** `join` put this session on the board alongside its owner. */
	parallel?: boolean;
	/** Session that owns the board, as `join` found it. */
	owner?: string;
}

function urlForRecord(record: IssueRecord): string {
	return `issues://${record.filename}`;
}

const BODY_PREVIEW_MAX = 200;
function extractBodyPreview(body: string): string | undefined {
	const trimmed = body.trim();
	if (!trimmed) return undefined;
	const firstPara = trimmed
		.split(/\n\s*\n/)[0]
		.replace(/\s+/g, " ")
		.trim();
	if (firstPara.length <= BODY_PREVIEW_MAX) return firstPara;
	return `${firstPara.slice(0, BODY_PREVIEW_MAX - 1).trimEnd()}…`;
}

function detailsFromRecord(op: IssuesToolParams["op"], record: IssueRecord): IssuesToolDetails {
	const location = record.frontmatter.location;
	const confidenceRaw = record.frontmatter.confidence;
	const confidence = typeof confidenceRaw === "number" ? confidenceRaw : undefined;
	return {
		op,
		id: record.id,
		category: record.category,
		filename: record.filename,
		url: urlForRecord(record),
		archived: record.archived,
		title: record.frontmatter.title,
		severity: record.frontmatter.severity,
		status: record.frontmatter.status,
		stage: record.frontmatter.stage,
		bodyPreview: extractBodyPreview(record.body),
		location: Array.isArray(location) && location.length > 0 ? location[0] : undefined,
		confidence,
	};
}

function summarizeRecord(verb: string, record: IssueRecord, extra?: string): string {
	const tag = record.frontmatter.severity ? ` [${record.frontmatter.severity}]` : "";
	const status = record.frontmatter.status ? ` (${record.frontmatter.status})` : "";
	const archived = record.archived ? " (archived)" : "";
	const extraStr = extra ? `\n${extra}` : "";
	return `${verb} #${record.id} ${urlForRecord(record)}${tag}${status}${archived}\n${record.frontmatter.title}${extraStr}`;
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(op: IssuesToolParams["op"], error: unknown): AgentToolResult<IssuesToolDetails> {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `issues ${op} failed: ${message}` }],
		details: { op, error: message },
		isError: true,
	};
}

async function executeAdd(
	cwd: string,
	params: Extract<IssuesToolParams, { op: "add" }>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const input: AddIssueInput = {
		category: params.category,
		title: params.title,
		body: params.body,
		severity: params.severity,
		status: params.status,
		report: params.report,
		location: params.location,
		extra: params.extra,
	};
	const { record } = await addIssue(cwd, input);
	return textResult(summarizeRecord("Created", record), detailsFromRecord("add", record));
}

async function executeArchive(
	cwd: string,
	params: Extract<IssuesToolParams, { op: "archive" }>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const before = await findIssueById(cwd, params.id);
	const { record, wasArchived } = await archiveIssue(cwd, params.id, {
		reason: params.reason,
		status: params.status,
	});
	const details: IssuesToolDetails = {
		...detailsFromRecord("archive", record),
		unchanged: wasArchived,
		previousStatus: before?.frontmatter.status,
		previousArchived: before?.archived,
	};
	return textResult(summarizeRecord(wasArchived ? "Already archived" : "Archived", record), details);
}

async function executeUnarchive(
	cwd: string,
	params: Extract<IssuesToolParams, { op: "unarchive" }>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const before = await findIssueById(cwd, params.id);
	const { record, wasActive } = await unarchiveIssue(cwd, params.id, {
		status: params.status,
	});
	const details: IssuesToolDetails = {
		...detailsFromRecord("unarchive", record),
		unchanged: wasActive,
		previousStatus: before?.frontmatter.status,
		previousArchived: before?.archived,
	};
	return textResult(summarizeRecord(wasActive ? "Already active" : "Unarchived", record), details);
}

async function executeStage(
	cwd: string,
	params: Extract<IssuesToolParams, { op: "stage" }>,
	sessionId: string | undefined,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const before = await findIssueById(cwd, params.id);
	// Archived issues carry no stage; say so instead of reporting a stage that was not kept.
	if (before?.archived) throw new Error(`Issue #${params.id} is archived; unarchive it before setting a stage.`);
	const record = await moveIssue(cwd, params.id, { stage: params.stage === "none" ? null : params.stage });
	const details: IssuesToolDetails = {
		...detailsFromRecord("stage", record),
		previousStage: before?.frontmatter.stage,
		unchanged: before?.frontmatter.stage === record.frontmatter.stage,
	};
	let text =
		params.stage === "none" ? `#${record.id} stage cleared` : `#${record.id} stage → ${record.frontmatter.stage}`;
	// Setting an issue running is starting it, so the session takes the claim —
	// unless a live session already works it. The claim is bookkeeping: a failed
	// write must not turn a stage the file already carries into an error.
	if (params.stage === "running" && sessionId !== undefined) {
		try {
			const holder = await claimOwner(cwd, record.id);
			if (holder !== undefined && holder !== sessionId && !(await claimIsStale(cwd, record.id))) {
				text += `\n#${record.id} is held by another live session (${holder.slice(0, 6)}); two sessions on one issue will conflict, so tell the user.`;
			} else {
				await claim(cwd, record.id, sessionId);
			}
		} catch {
			// The stage is what the board shows; a claim that could not be written is not worth failing the op.
		}
	}
	return textResult(text, details);
}

/**
 * Put this session on the board alongside its owner: it is handed queued issues
 * and replies too, which is what the user asked for. Needs the main session —
 * a subagent has no board of its own.
 */
async function executeJoin(cwd: string, sessionId: string | undefined): Promise<AgentToolResult<IssuesToolDetails>> {
	if (sessionId === undefined) {
		throw new Error("`join` needs the main session's id; a subagent cannot take board work.");
	}
	await touchPresence(cwd, sessionId, { parallel: true });
	const owner = await boardOwner(cwd);
	const other = owner !== undefined && owner !== sessionId ? owner : undefined;
	const text =
		other === undefined
			? "This session now takes board work in parallel (no other owner)"
			: `This session now takes board work in parallel with ${other.slice(0, 6)}`;
	return textResult(text, { op: "join", parallel: true, owner });
}

async function executeList(
	cwd: string,
	params: Extract<IssuesToolParams, { op: "list" }>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const summaries = await listIssues(cwd, {
		category: params.category ? normalizeCategory(params.category) : undefined,
		archived: params.archived,
		severity: params.severity,
		status: params.status,
		query: params.query,
		limit: params.limit,
	});
	const scopeBits: string[] = [];
	if (params.archived === true) scopeBits.push("archived");
	else if (params.archived === false) scopeBits.push("active");
	else scopeBits.push("active+archive");
	if (params.category) scopeBits.push(`category=${params.category}`);
	if (params.severity) scopeBits.push(`severity=${params.severity}`);
	if (params.status) scopeBits.push(`status=${params.status}`);
	if (params.query) scopeBits.push(`q=${JSON.stringify(params.query)}`);
	const title = `# Issues (${summaries.length}, ${scopeBits.join(", ")})`;
	const text = renderIssueListing(summaries, {
		title,
		emptyText: "_No matching issues._",
		group: true,
		showArchived: params.archived === undefined,
	});
	const filters: IssueFilters = {
		category: params.category,
		archived: params.archived,
		severity: params.severity,
		status: params.status,
		query: params.query,
		limit: params.limit,
	};
	return textResult(text, { op: "list", listing: summaries, filters });
}

/** Options a caller supplies: the abort signal, and the main session id when there is one. */
export interface RunIssuesOptions {
	signal?: AbortSignal;
	/** Main session id; absent in a subagent, which cannot take board work. */
	sessionId?: string;
}

/** Run one `issues` op. Split out of {@link issuesTool} so tests drive it without the host. */
export async function runIssuesOp(
	cwd: string,
	params: IssuesToolParams,
	options: RunIssuesOptions = {},
): Promise<AgentToolResult<IssuesToolDetails>> {
	return untilAborted(options.signal, async () => {
		try {
			switch (params.op) {
				case "add":
					return await executeAdd(cwd, params);
				case "archive":
					return await executeArchive(cwd, params);
				case "unarchive":
					return await executeUnarchive(cwd, params);
				case "stage":
					return await executeStage(cwd, params, options.sessionId);
				case "list":
					return await executeList(cwd, params);
				case "join":
					return await executeJoin(cwd, options.sessionId);
			}
		} catch (error) {
			return errorResult(params.op, error);
		}
	});
}

export const issuesTool: ToolDefinition<typeof issuesSchema, IssuesToolDetails> = {
	name: "issues",
	label: "Issues",
	description: prompt.render(issuesDescription),
	parameters: issuesSchema,
	approval: "write",
	strict: true,
	loadMode: "discoverable",
	async execute(
		_toolCallId: string,
		input: IssuesToolParams,
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<IssuesToolDetails>> {
		const settings = await readIssuesSettings(ctx.cwd);
		if (!settings.enabled) {
			throw new Error("The issues tool is disabled by the `omp-issues` plugin setting `enabled`.");
		}
		return runIssuesOp(ctx.cwd, input, {
			signal,
			sessionId: ctx.agent.kind === "main" ? ctx.sessionManager.getSessionId() : undefined,
		});
	},
	renderCall: renderIssuesCall,
	renderResult: renderIssuesResult,
};
