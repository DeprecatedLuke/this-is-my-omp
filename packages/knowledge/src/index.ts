/**
 * omp-knowledge — project knowledge base plugin.
 *
 * Owns everything the core used to: the `.omp/knowledge` note format, the
 * `knowledge://` scheme, the `# Knowledge` prompt index, the session-distill
 * passes, the end-of-turn catalogue reminder, and the `/knowledge` command.
 */
import type { Api, Message, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import {
	completeKnowledgeArguments,
	KNOWLEDGE_USAGE,
	type KnowledgeCommand,
	parseKnowledgeCommand,
} from "./command-args";
import { buildFromSessions, parseLastDurationMs } from "./exporter";
import { renderKnowledgeSection } from "./prompt";
import { KnowledgeProtocolHandler } from "./protocol";
import {
	decideKnowledgeReminder,
	KNOWLEDGE_REMINDER_MESSAGE_TYPE,
	KNOWLEDGE_WATERMARK_CUSTOM_TYPE,
	renderKnowledgeReminder,
} from "./reminder";
import {
	KNOWLEDGE_PASS_MESSAGE_TYPE,
	type KnowledgePassDetails,
	renderKnowledgePassMessage,
	toDetails,
} from "./render";
import type { KnowledgePassReport } from "./runner";
import { type PassContext, runMaintenancePass, runSavePass } from "./runner";
import { loadKnowledgeSettings } from "./settings";
import { hostSettings } from "./tools";

/** Install the `knowledge://` handler into the host's process-global router once. */
function installKnowledgeScheme(log: (message: string) => void): void {
	const router = InternalUrlRouter.instance();
	if (router.getHandler("knowledge") instanceof KnowledgeProtocolHandler) return;
	try {
		router.register(new KnowledgeProtocolHandler());
	} catch (error) {
		log(`knowledge:// scheme registration failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function messageEntries(entries: readonly SessionEntry[]): SessionMessageEntry[] {
	return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
}

/** Running background jobs or undelivered results: the session re-wakes on its own. */
function hasPendingBackgroundWork(ctx: ExtensionContext): boolean {
	const snapshot = ctx.getAsyncJobSnapshot();
	if (snapshot === null) return false;
	return snapshot.running.length > 0 || snapshot.delivery.queued > 0 || snapshot.delivery.delivering;
}

/** Session context converted for a headless pass seeded with the conversation. */
function historyToMessages(entries: readonly SessionEntry[]): Message[] {
	return convertToLlm(messageEntries(entries).map(entry => entry.message));
}

interface PassRuntime {
	cwd: string;
	model: Model<Api>;
	apiKey: string;
	systemPrompt: string[];
}

/** Model + key + prompt for a pass; `modelOverride` is a role alias or `provider/model`. */
async function resolvePassRuntime(ctx: ExtensionContext, modelOverride?: string): Promise<PassRuntime | undefined> {
	let model = ctx.model;
	if (modelOverride) {
		const settings = await hostSettings();
		model = resolveModelRoleValue(modelOverride, ctx.modelRegistry.getAvailable(), { settings }).model ?? model;
	}
	if (!model) return undefined;
	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) return undefined;
	return { cwd: ctx.cwd, model, apiKey, systemPrompt: ctx.getSystemPrompt() };
}

function passContext(runtime: PassRuntime, signal?: AbortSignal): PassContext {
	return { ...runtime, signal };
}

function describeReport(report: KnowledgePassReport): string {
	const created = report.changes.filter(change => change.kind === "created").length;
	const updated = report.changes.filter(change => change.kind === "updated").length;
	const deleted = report.changes.filter(change => change.kind === "deleted").length;
	const parts = [`${report.title}: ${report.status}`];
	if (report.changes.length > 0) parts.push(`${created} new, ${updated} updated, ${deleted} deleted`);
	if (report.patches.length > 0) parts.push(`${report.patches.length} pending patch(es)`);
	if (report.commit) parts.push(`commit ${report.commit}`);
	return parts.join(" — ");
}

export default function knowledgePlugin(pi: ExtensionAPI): void {
	installKnowledgeScheme(message => pi.logger.warn(message));
	pi.setLabel("knowledge");

	/** A `/knowledge` pass in flight: it already owns `.omp/knowledge`, so no reminder. */
	let manualPasses = 0;

	const publishPass = (ctx: ExtensionContext, details: KnowledgePassDetails): void => {
		const text = [details.title, details.status].join(": ");
		if (ctx.isIdle()) {
			pi.sendMessage(
				{ customType: KNOWLEDGE_PASS_MESSAGE_TYPE, content: text, display: true, details },
				{ triggerTurn: false },
			);
			return;
		}
		// Mid-turn: never steer the running agent with a card it cannot see usefully.
		ctx.ui.notify(text, details.status === "failed" ? "error" : "info");
	};

	const withStatus = async <T>(
		ctx: ExtensionContext,
		title: string,
		phase: string,
		work: () => Promise<T>,
	): Promise<T> => {
		ctx.ui.setStatus("knowledge", `${title} — ${phase}`);
		try {
			return await work();
		} finally {
			ctx.ui.setStatus("knowledge", undefined);
		}
	};

	// `# Knowledge` index: appended to every session's prompt (main and subagents,
	// like the core block it replaces) so any agent can find existing notes.
	pi.on("before_agent_start", async (event, ctx) => {
		const section = await renderKnowledgeSection(ctx.cwd).catch(error => {
			logger.debug("knowledge index render failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		});
		if (!section) return;
		return { systemPrompt: [...event.systemPrompt, section] };
	});

	// Keep pass cards out of the model's context: they exist for the operator.
	pi.on("context", event => {
		const filtered = event.messages.filter(
			message => !(message.role === "custom" && message.customType === KNOWLEDGE_PASS_MESSAGE_TYPE),
		);
		return filtered.length === event.messages.length ? undefined : { messages: filtered };
	});

	pi.registerMessageRenderer(KNOWLEDGE_PASS_MESSAGE_TYPE, renderKnowledgePassMessage);

	// Knowledge hint: once enough non-cached provider work piled up since the
	// watermark, a hidden system-reminder rides along with the next turn. It is
	// passive on purpose — no forced continuation, so it never competes with
	// other plugins' `session_stop` continuations (first one wins there).
	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue || event.awaitingAsyncWork) return;
		if (ctx.agent.kind !== "main") return;
		if (hasPendingBackgroundWork(ctx)) return;
		const settings = await loadKnowledgeSettings(ctx.cwd).catch(() => undefined);
		if (!settings) return;
		const plan = decideKnowledgeReminder({
			entries: ctx.sessionManager.getBranch(),
			thresholdTokens: settings.reminderThresholdTokens,
			agentKind: ctx.agent.kind,
			busy: manualPasses > 0,
		});
		if (!plan) return;
		// Advance the watermark when the hint is queued: each crossing is offered once.
		pi.appendEntry(KNOWLEDGE_WATERMARK_CUSTOM_TYPE, plan.watermark);
		pi.sendMessage(
			{
				customType: KNOWLEDGE_REMINDER_MESSAGE_TYPE,
				content: renderKnowledgeReminder(plan.totalTokens),
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn" },
		);
	});

	const runCommandPass = async (ctx: ExtensionContext, title: string, command: KnowledgeCommand): Promise<void> => {
		const override = "model" in command ? command.model : undefined;
		const runtime = await resolvePassRuntime(ctx, override);
		if (!runtime) {
			ctx.ui.notify("Knowledge: no model with an API key is available.", "error");
			return;
		}
		manualPasses += 1;
		try {
			const report = await withStatus(ctx, title, "starting", async () => {
				switch (command.kind) {
					case "save":
						return await runSavePass(passContext(runtime), {
							messages: historyToMessages(ctx.sessionManager.getBranch()),
							sourceTitle: "/knowledge save",
						});
					case "build":
						return await runMaintenancePass(passContext(runtime), {
							kind: "build",
							focus: command.focus,
							taskId: `knowledge-build:${Snowflake.next()}`,
						});
					case "update":
						return await runMaintenancePass(passContext(runtime), {
							kind: "update",
							focus: command.focus,
							taskId: `knowledge-update:${Snowflake.next()}`,
						});
					case "compact":
						return await runMaintenancePass(passContext(runtime), {
							kind: "compact",
							goal: command.goal,
							taskId: `knowledge-compact:${Snowflake.next()}`,
						});
					default:
						throw new Error(`unhandled knowledge subcommand: ${command.kind}`);
				}
			});
			ctx.ui.notify(describeReport(report), report.status === "failed" ? "error" : "info");
			publishPass(ctx, toDetails(report));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Knowledge: ${message}`, "error");
			publishPass(ctx, {
				title,
				status: "failed",
				changes: [],
				patches: [],
				error: message,
				durationMs: 0,
			});
		} finally {
			manualPasses -= 1;
		}
	};

	const runSessionsExport = async (
		ctx: ExtensionContext,
		command: Extract<KnowledgeCommand, { kind: "build-sessions" }>,
	): Promise<void> => {
		const settings = await hostSettings();
		const progress: string[] = [];
		const startedAt = Date.now();
		try {
			parseLastDurationMs(command.last);
			const result = await withStatus(ctx, "Knowledge build", "exporting sessions", () =>
				buildFromSessions(
					{ last: command.last, force: command.force, model: command.model },
					{
						cwd: ctx.cwd,
						settings,
						availableModels: ctx.modelRegistry.getAvailable(),
						getApiKey: model => ctx.modelRegistry.getApiKey(model),
						onProgress: line => {
							progress.push(line);
							ctx.ui.setStatus("knowledge", line);
						},
					},
				),
			);
			const details: KnowledgePassDetails = {
				title: "Knowledge build (sessions)",
				status: result.failed > 0 ? "failed" : result.exported > 0 ? "completed" : "empty",
				changes: [],
				patches: [],
				progress,
				durationMs: Date.now() - startedAt,
				summary: `matched ${result.matched}, exported ${result.exported}, committed ${result.committed}, empty ${result.empty}, already exported ${result.skippedAlreadyExported}, missing cwd ${result.skippedMissingCwd}, failed ${result.failed}`,
			};
			ctx.ui.notify(`Knowledge build: exported ${result.exported} session(s), committed ${result.committed}.`);
			publishPass(ctx, details);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Knowledge build: ${message}`, "error");
			publishPass(ctx, {
				title: "Knowledge build (sessions)",
				status: "failed",
				changes: [],
				patches: [],
				progress,
				error: message,
				durationMs: Date.now() - startedAt,
			});
		}
	};

	pi.registerCommand("knowledge", {
		description: "Save, build, update, or compact the project knowledge base",
		getArgumentCompletions: completeKnowledgeArguments,
		handler: async (args, ctx) => {
			const parsed = parseKnowledgeCommand(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			const command = parsed.command;
			if (command.kind === "help") {
				ctx.ui.notify(KNOWLEDGE_USAGE, "info");
				return;
			}
			if (command.kind === "build-sessions") {
				await runSessionsExport(ctx, command);
				return;
			}
			const title =
				command.kind === "save"
					? "Knowledge save"
					: command.kind === "build"
						? "Knowledge build"
						: command.kind === "update"
							? "Knowledge update"
							: "Knowledge compact";
			await runCommandPass(ctx, title, command);
		},
	});

	pi.logger.debug("knowledge plugin ready");
}
