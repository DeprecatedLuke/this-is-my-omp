/**
 * Knowledge maintenance pass that must land as a reviewable native patch
 * instead of a direct commit. It delegates capture/apply to the host's generic
 * native-patch machinery (`createTaskNativePatches` / `applyTaskNativePatches`),
 * scoped to the `.omp/knowledge` subtree.
 */
import * as path from "node:path";
import { defaultPatchStore } from "@oh-my-pi/pi-coding-agent/patches";
import { detectGitRepos } from "@oh-my-pi/pi-coding-agent/patches/repos";
import {
	applyTaskNativePatches,
	buildPatchTargets,
	createTaskNativePatches,
	patchSummaryFromManifest,
} from "@oh-my-pi/pi-coding-agent/task";
import type { TaskPatchSummary } from "@oh-my-pi/pi-coding-agent/task/types";
import {
	cleanupIsolation,
	ensureIsolation,
	type IsolationBackendSetting,
	type IsolationHandle,
	parseIsolationBackend,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { diffKnowledgeSnapshots, type KnowledgeChange, snapshotKnowledge } from "./snapshot";

/** Subtree owned by every knowledge pass; capture is scoped to it. */
const KNOWLEDGE_SUBTREE = ".omp/knowledge";

/** Outcome of an isolated knowledge-maintenance pass. */
export interface KnowledgePassResult {
	exitCode: number;
	aborted: boolean;
	patches: TaskPatchSummary[];
	/** Notes created/updated/deleted in the real tree, when the pass landed. */
	changes: KnowledgeChange[];
	/** Human summary of where the edits went (auto-applied / pending / conflicted). */
	summary: string;
}

type GenerateMessage = (manifest: { id: string }) => Promise<string>;

function summarizePatches(patches: readonly TaskPatchSummary[]): string {
	if (patches.length === 0) return "No knowledge changes to apply.";
	const applied = patches.filter(patch => patch.status === "applied");
	const pending = patches.filter(patch => patch.status !== "applied");
	const lines: string[] = [];
	if (applied.length > 0) {
		lines.push(`applied: ${applied.map(patch => patch.uri).join(", ")}`);
	}
	if (pending.length > 0) {
		lines.push(
			`pending: ${pending
				.map(patch => `${patch.uri} (${patch.status}${patch.error ? `: ${patch.error}` : ""})`)
				.join(", ")}`,
		);
	}
	return lines.join("; ");
}

/**
 * Run a knowledge-maintenance subagent in an isolated worktree and capture its
 * `.omp/knowledge` edits as a native patch — instead of writing and committing
 * the real tree directly. The patch auto-applies when the target repo is clean
 * and is left pending (for `patch apply`) when it is dirty or conflicts,
 * exactly like an isolated `task` spawn.
 *
 * Isolation is forced regardless of `task.isolation.*`: knowledge maintenance
 * must always produce a reviewable patch. `runInWorktree` MUST run the subagent
 * with its cwd set to the provided worktree dir and resolve with its status.
 */
export async function runIsolatedKnowledgePass(options: {
	cwd: string;
	taskId: string;
	description: string;
	generateMessage: GenerateMessage;
	/**
	 * Isolation backend hint (from `isolation.backend`). Knowledge maintenance
	 * MUST isolate even when the setting is absent, so an omitted value is forced
	 * to `rcopy` — the always-available, privilege-free backend. `auto` stays
	 * `auto` (the resolver picks the best backend); an explicit backend is honored.
	 */
	isolationBackend?: IsolationBackendSetting;
	runInWorktree: (worktreeDir: string) => Promise<{ exitCode: number; aborted: boolean }>;
}): Promise<KnowledgePassResult> {
	const backend = parseIsolationBackend(options.isolationBackend ?? "rcopy");
	const discovered = await detectGitRepos(options.cwd);
	const isolationRoot = path.resolve(discovered?.root ?? options.cwd);
	const targets = buildPatchTargets(
		options.cwd,
		isolationRoot,
		discovered ? (discovered.repos.length > 0 ? discovered.repos : [isolationRoot]) : null,
	);
	const store = defaultPatchStore(options.cwd);
	// Knowledge lives at `<repo-root>/.omp/knowledge`; the worktree mirrors the
	// repo root, so the subagent's cwd is the root and entry paths are
	// root-relative. Scope capture to that subtree.
	const pathFilter = (relativePath: string): boolean =>
		relativePath === KNOWLEDGE_SUBTREE || relativePath.startsWith(`${KNOWLEDGE_SUBTREE}/`);
	const before = await snapshotKnowledge(options.cwd);

	const baseline = await ensureIsolation(isolationRoot, `knowledge-baseline-${Snowflake.next()}`, backend);
	let task: IsolationHandle | undefined;
	try {
		task = await ensureIsolation(baseline.mergedDir, options.taskId, backend);
		const run = await options.runInWorktree(task.mergedDir);
		if (run.exitCode !== 0 || run.aborted) {
			// Capture (do not apply) any edits so the work survives in the durable
			// store for manual `patch` inspection; report the failure.
			const captured = await createTaskNativePatches({
				store,
				baselineRoot: baseline.mergedDir,
				changedRoot: task.mergedDir,
				targets,
				taskId: options.taskId,
				description: options.description,
				pathFilter,
			});
			const patches = captured.map(({ manifest, target }) =>
				patchSummaryFromManifest(manifest, target, "pending", { recovery: true }),
			);
			return {
				exitCode: run.exitCode,
				aborted: run.aborted,
				patches,
				changes: [],
				summary: patches.length > 0 ? `preserved ${summarizePatches(patches)}` : "no captured changes",
			};
		}
		const captured = await createTaskNativePatches({
			store,
			baselineRoot: baseline.mergedDir,
			changedRoot: task.mergedDir,
			targets,
			taskId: options.taskId,
			description: options.description,
			pathFilter,
		});
		const patches = captured.length > 0 ? await applyTaskNativePatches(store, captured, options.generateMessage) : [];
		const changes = diffKnowledgeSnapshots(before, await snapshotKnowledge(options.cwd));
		return {
			exitCode: 0,
			aborted: false,
			patches,
			changes,
			summary: summarizePatches(patches),
		};
	} finally {
		if (task) await cleanupIsolation(task);
		await cleanupIsolation(baseline);
	}
}
