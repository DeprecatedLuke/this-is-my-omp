/**
 * `/knowledge build --sessions`: backfill the knowledge base from SAVED
 * sessions. Ported from the dropped `omp build-knowledge` CLI: same export
 * state file, same `--last` window, same per-session distill through a headless
 * agent, but flushing progress through a callback instead of stdout.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { resolveModelRoleValue, resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { obfuscateProviderContext } from "@oh-my-pi/pi-coding-agent/secrets";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { FileEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { migrateSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { type RunSessionKnowledgeAgentResult, runSessionKnowledgeAgent } from "./agent-pass";
import { fingerprintKnowledgeRoot, getKnowledgeRoot, normalizeKnowledgePath } from "./knowledge-index";
import sessionKnowledgeTemplate from "./prompts/session-knowledge.md" with { type: "text" };
import { buildPassObfuscator, createPassTools, NOTE_TOOLS } from "./tools";

const DEFAULT_LAST = "30d";
const STATE_VERSION = 1;
/** Roles tried, in order, when no explicit model is given. */
const KNOWLEDGE_MODEL_ROLES = ["task", "smol", "default", "slow"] as const;

export interface BuildFromSessionsArgs {
	/** `--last` window: `30d`, `72h`, `2w`, or `all`. Defaults to 30 days. */
	last?: string;
	/** `--model` override (role alias or `provider/model`). */
	model?: string;
	/** `--force`: re-export sessions even when the state file says they are done. */
	force?: boolean;
}

interface KnowledgeExportRecord {
	sessionId: string;
	path: string;
	cwd: string;
	modifiedMs: number;
	size: number;
	messageCount: number;
	exportedAt: string;
	status: "exported" | "empty";
	committed: boolean;
	sha?: string;
	/** Note paths an older exporter recorded for this session; verified before trusting a cached fingerprint. */
	written?: unknown;
}

interface KnowledgeExportState {
	version: typeof STATE_VERSION;
	knowledgeFingerprint?: string;
	sessions: Record<string, KnowledgeExportRecord>;
}

export interface SessionKnowledgeExportJob {
	session: SessionInfo;
	sourceTitle: string;
	messages: readonly Message[];
}

export type SessionKnowledgeExporter = (
	job: SessionKnowledgeExportJob,
) => Promise<RunSessionKnowledgeAgentResult | undefined>;

export interface BuildFromSessionsResult {
	matched: number;
	processed: number;
	exported: number;
	empty: number;
	skippedAlreadyExported: number;
	skippedMissingCwd: number;
	failed: number;
	committed: number;
}

export interface BuildFromSessionsDeps {
	settings: Settings;
	cwd: string;
	availableModels: readonly Model<Api>[];
	getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	signal?: AbortSignal;
	/** Progress line for the card/status, called once per session. */
	onProgress?: (line: string) => void;
	listSessions?: () => Promise<SessionInfo[]>;
	exportSession?: SessionKnowledgeExporter;
	statePath?: string;
	now?: () => Date;
	cwdExists?: (cwd: string) => Promise<boolean>;
}

function defaultStatePath(cwd: string): string {
	return path.join(SessionManager.getDefaultSessionDir(cwd), "knowledge-exports.json");
}

function legacyProjectStatePath(cwd: string): string {
	return path.join(cwd, ".omp", "knowledge", ".exported-sessions.json");
}

function emptyState(): KnowledgeExportState {
	return { version: STATE_VERSION, sessions: {} };
}

function parseExportState(value: unknown): KnowledgeExportState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as { version?: unknown; sessions?: unknown };
	if (record.version !== STATE_VERSION || !record.sessions || typeof record.sessions !== "object") {
		return undefined;
	}
	return record as KnowledgeExportState;
}

async function readStateFile(statePath: string): Promise<KnowledgeExportState | undefined> {
	try {
		return parseExportState((await Bun.file(statePath).json()) as unknown);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function saveState(statePath: string, state: KnowledgeExportState): Promise<void> {
	await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function mergeStates(current: KnowledgeExportState | undefined, legacy: KnowledgeExportState): KnowledgeExportState {
	return {
		version: STATE_VERSION,
		sessions: { ...legacy.sessions, ...current?.sessions },
		knowledgeFingerprint: current?.knowledgeFingerprint,
	};
}

async function loadState(statePath: string, legacyStatePath?: string): Promise<KnowledgeExportState> {
	const current = await readStateFile(statePath);
	if (!legacyStatePath) return current ?? emptyState();

	const legacy = await readStateFile(legacyStatePath);
	if (!legacy) return current ?? emptyState();

	const migrated = mergeStates(current, legacy);
	await saveState(statePath, migrated);
	await fs.rm(legacyStatePath, { force: true });
	return migrated;
}

async function recordedKnowledgeOutputsExist(cwd: string, state: KnowledgeExportState): Promise<boolean> {
	const root = getKnowledgeRoot(cwd);
	for (const record of Object.values(state.sessions)) {
		if (record.status === "empty") continue;
		const written = record.written;
		if (!Array.isArray(written) || written.length === 0) return false;
		for (const item of written) {
			if (typeof item !== "string") return false;
			const relativePath = normalizeKnowledgePath(item);
			if (!relativePath) return false;
			if (!(await Bun.file(path.join(root, ...relativePath.split("/"))).exists())) {
				return false;
			}
		}
	}
	return true;
}

async function alignStateWithKnowledgeRoot(
	cwd: string,
	statePath: string,
	state: KnowledgeExportState,
	write: (text: string) => void,
): Promise<KnowledgeExportState> {
	const currentFingerprint = await fingerprintKnowledgeRoot(cwd);
	if (state.knowledgeFingerprint === currentFingerprint) return state;

	if (!state.knowledgeFingerprint && (await recordedKnowledgeOutputsExist(cwd, state))) {
		const nextState = { ...state, knowledgeFingerprint: currentFingerprint };
		await saveState(statePath, nextState);
		return nextState;
	}

	const cached = Object.keys(state.sessions).length;
	if (cached > 0) {
		write(
			`Knowledge files changed since the last export; invalidating ${cached} cached session fingerprint${cached === 1 ? "" : "s"}.`,
		);
	}
	const nextState: KnowledgeExportState = {
		version: STATE_VERSION,
		knowledgeFingerprint: currentFingerprint,
		sessions: {},
	};
	await saveState(statePath, nextState);
	return nextState;
}

export function parseLastDurationMs(value: string | undefined): number {
	const raw = (value ?? DEFAULT_LAST).trim().toLowerCase();
	if (raw === "all") return Number.POSITIVE_INFINITY;
	const match = /^(\d+)(ms|m|h|d|w)?$/.exec(raw);
	if (!match) {
		throw new Error(`Invalid --last value "${value}". Use a duration like 30d, 72h, 2w, or all.`);
	}
	const amount = Number(match[1]);
	const unit = match[2] ?? "d";
	switch (unit) {
		case "ms":
			return amount;
		case "m":
			return amount * 60_000;
		case "h":
			return amount * 60 * 60_000;
		case "w":
			return amount * 7 * 24 * 60 * 60_000;
		default:
			return amount * 24 * 60 * 60_000;
	}
}

function isAlreadyExported(session: SessionInfo, record: KnowledgeExportRecord | undefined): boolean {
	if (!record) return false;
	return (
		record.path === path.resolve(session.path) &&
		record.modifiedMs === session.modified.getTime() &&
		record.size === session.size &&
		record.messageCount === session.messageCount &&
		(record.status === "exported" || record.status === "empty")
	);
}

function titleForSession(session: SessionInfo): string {
	const title = session.title?.trim() || session.firstMessage.trim();
	if (!title || title === "(no messages)") return session.id;
	const singleLine = title.replace(/\s+/g, " ");
	return singleLine.length > 96 ? `${singleLine.slice(0, 93)}...` : singleLine;
}

function sourceTitleForSession(session: SessionInfo): string {
	const title = titleForSession(session);
	return title === session.id ? `session ${session.id}` : `${title} (${session.id})`;
}

function formatProgressSession(session: SessionInfo): string {
	const cwd = session.cwd ? shortenPath(session.cwd) : "(unknown cwd)";
	return `${session.id.slice(0, 8)} ${cwd}`;
}

async function defaultCwdExists(cwd: string): Promise<boolean> {
	if (!cwd) return false;
	try {
		return (await fs.stat(cwd)).isDirectory();
	} catch {
		return false;
	}
}

function fileEntriesToSessionEntries(entries: readonly FileEntry[]): SessionEntry[] {
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

function textOnlyMessage(message: Message): Message | undefined {
	if (message.role === "assistant") {
		const content = message.content.filter(
			(block): block is TextContent => block.type === "text" && block.text.length > 0,
		);
		return content.length > 0 ? { ...message, content } : undefined;
	}
	if (typeof message.content === "string") {
		return message.content.trim().length > 0 ? message : undefined;
	}
	const content = message.content.filter(
		(block): block is TextContent => block.type === "text" && block.text.length > 0,
	);
	if (content.length === 0) return undefined;
	if (content.length === message.content.length) return message;
	return { ...message, content };
}

async function loadSessionKnowledgeJob(session: SessionInfo): Promise<SessionKnowledgeExportJob> {
	const entries = await loadEntriesFromFile(session.path);
	migrateSessionEntries(entries);
	const context = buildSessionContext(fileEntriesToSessionEntries(entries));
	const messages = convertToLlm(context.messages)
		.map(textOnlyMessage)
		.filter((message): message is Message => message !== undefined);
	return { session, sourceTitle: sourceTitleForSession(session), messages };
}

function filterSessionsByAge(sessions: SessionInfo[], now: Date, lastMs: number): SessionInfo[] {
	const cutoffMs = Number.isFinite(lastMs) ? now.getTime() - lastMs : Number.NEGATIVE_INFINITY;
	return sessions
		.filter(session => session.modified.getTime() >= cutoffMs)
		.sort((a, b) => a.modified.getTime() - b.modified.getTime());
}

function makeRecord(
	session: SessionInfo,
	now: Date,
	status: KnowledgeExportRecord["status"],
	result: RunSessionKnowledgeAgentResult | undefined,
): KnowledgeExportRecord {
	return {
		sessionId: session.id,
		path: path.resolve(session.path),
		cwd: session.cwd,
		modifiedMs: session.modified.getTime(),
		size: session.size,
		messageCount: session.messageCount,
		committed: result?.committed ?? false,
		sha: result?.sha,
		exportedAt: now.toISOString(),
		status,
	};
}

/** Model for the export passes: `--model` when given, else the first available knowledge role. */
export function resolveExportModel(
	modelOverride: string | undefined,
	settings: Settings,
	available: readonly Model<Api>[],
): Model<Api> | undefined {
	const models = [...available];
	if (modelOverride) return resolveModelRoleValue(modelOverride, models, { settings }).model;
	return resolveRoleSelection(KNOWLEDGE_MODEL_ROLES, settings, models)?.model ?? models[0];
}

function createProductionExporter(
	deps: BuildFromSessionsDeps,
	model: Model<Api>,
	apiKey: string,
): SessionKnowledgeExporter {
	const promptCache = new Map<string, Promise<string[]>>();
	const systemPromptForCwd = async (cwd: string): Promise<string[]> => {
		const fingerprint = await fingerprintKnowledgeRoot(cwd);
		const key = `${path.resolve(cwd)}\0${fingerprint}`;
		const cached = promptCache.get(key);
		if (cached) return await cached;
		const pending = buildSystemPrompt({
			cwd,
			tools: new Map(),
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		}).then(result => result.systemPrompt);
		promptCache.set(key, pending);
		return await pending;
	};
	return async job => {
		const baseSystemPrompt = await systemPromptForCwd(job.session.cwd);
		const settings = deps.settings;
		const obfuscator = await buildPassObfuscator(job.session.cwd, settings);
		return await runSessionKnowledgeAgent({
			cwd: job.session.cwd,
			sourceTitle: job.sourceTitle,
			signal: deps.signal,
			instruction: prompt.render(sessionKnowledgeTemplate, { sourceTitle: job.sourceTitle }),
			metadata: { source: "knowledge-build", sessionId: job.session.id },
			agent: {
				initialState: {
					systemPrompt: baseSystemPrompt,
					messages: [...job.messages],
					model,
					tools: createPassTools(job.session.cwd, settings, NOTE_TOOLS),
				},
				streamFn: streamSimple,
				getApiKey: () => apiKey,
				convertToLlm,
				...(obfuscator
					? {
							transformProviderContext: (context: Parameters<typeof obfuscateProviderContext>[1]) =>
								obfuscateProviderContext(obfuscator, context),
						}
					: {}),
				sessionId: job.session.id,
			},
		});
	};
}

/**
 * Export every saved session inside the `--last` window into the project
 * knowledge base, skipping sessions the state file already covered.
 */
export async function buildFromSessions(
	args: BuildFromSessionsArgs,
	deps: BuildFromSessionsDeps,
): Promise<BuildFromSessionsResult> {
	const write = deps.onProgress ?? (() => {});
	const now = deps.now?.() ?? new Date();
	const lastMs = parseLastDurationMs(args.last);
	const cwd = deps.cwd;
	const statePath = deps.statePath ?? defaultStatePath(cwd);
	let state = await loadState(statePath, deps.statePath ? undefined : legacyProjectStatePath(cwd));
	const sessions = filterSessionsByAge(await (deps.listSessions?.() ?? SessionManager.list(cwd)), now, lastMs);
	const result: BuildFromSessionsResult = {
		matched: sessions.length,
		processed: 0,
		exported: 0,
		empty: 0,
		skippedAlreadyExported: 0,
		skippedMissingCwd: 0,
		failed: 0,
		committed: 0,
	};
	write(
		`Building knowledge for ${shortenPath(cwd)} from ${sessions.length} session${sessions.length === 1 ? "" : "s"}${
			Number.isFinite(lastMs) ? ` modified in the last ${args.last ?? DEFAULT_LAST}` : ""
		}.`,
	);
	state = await alignStateWithKnowledgeRoot(cwd, statePath, state, write);
	if (sessions.length === 0) return result;

	const model = resolveExportModel(args.model, deps.settings, deps.availableModels);
	if (!model) throw new Error("No model available for the knowledge build");
	const apiKey = await deps.getApiKey(model);
	if (!apiKey) throw new Error(`No API key available for ${model.provider}/${model.id}`);
	const exporter = deps.exportSession ?? createProductionExporter(deps, model, apiKey);
	const cwdExists = deps.cwdExists ?? defaultCwdExists;

	for (let index = 0; index < sessions.length; index++) {
		if (deps.signal?.aborted) break;
		const rawSession = sessions[index];
		const session = rawSession.cwd ? rawSession : { ...rawSession, cwd };
		const prefix = `[${index + 1}/${sessions.length}] ${formatProgressSession(session)}`;
		const key = session.id;
		if (!args.force && isAlreadyExported(session, state.sessions[key])) {
			result.skippedAlreadyExported += 1;
			write(`${prefix} — already exported`);
			continue;
		}
		if (!(await cwdExists(session.cwd))) {
			result.skippedMissingCwd += 1;
			write(`${prefix} — skipped, missing cwd`);
			continue;
		}
		try {
			const job = await loadSessionKnowledgeJob(session);
			if (job.messages.length === 0) {
				state.sessions[key] = makeRecord(session, deps.now?.() ?? new Date(), "empty", undefined);
				state.knowledgeFingerprint = await fingerprintKnowledgeRoot(cwd);
				await saveState(statePath, state);
				result.empty += 1;
				write(`${prefix} — no context messages`);
				continue;
			}
			result.processed += 1;
			write(`${prefix} — distilling`);
			const exportResult = await exporter(job);
			if (!exportResult) throw new Error("knowledge extraction failed");
			state.sessions[key] = makeRecord(session, deps.now?.() ?? new Date(), "exported", exportResult);
			state.knowledgeFingerprint = await fingerprintKnowledgeRoot(cwd);
			await saveState(statePath, state);
			result.exported += 1;
			if (exportResult.committed) result.committed += 1;
			write(
				exportResult.committed
					? `${prefix} — committed ${exportResult.sha ?? "knowledge"}`
					: `${prefix} — no knowledge changes`,
			);
		} catch (error) {
			result.failed += 1;
			logger.warn("knowledge build session export failed", {
				sessionId: session.id,
				path: session.path,
				error: error instanceof Error ? error.message : String(error),
			});
			write(`${prefix} — failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}
