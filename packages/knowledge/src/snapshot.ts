/**
 * Cheapest correct way to report what a knowledge pass changed: hash every
 * note under `.omp/knowledge` before and after, then diff the two maps. Works
 * for passes that write the real tree (save/export) and for patch passes that
 * apply their capture to it.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getKnowledgeRoot, normalizeKnowledgePath } from "./knowledge-index";

/** Note path (`<category>/<topic>.md`) to content hash. */
export type KnowledgeSnapshot = ReadonlyMap<string, string>;

export interface KnowledgeChange {
	path: string;
	kind: "created" | "updated" | "deleted";
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(root, full, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
		out.push(path.relative(root, full).split(path.sep).join("/"));
	}
}

/** Hashes every knowledge note, keyed by `<category>/<topic>.md`; empty when the tree is absent. */
export async function snapshotKnowledge(cwd: string): Promise<KnowledgeSnapshot> {
	const root = getKnowledgeRoot(cwd);
	const paths: string[] = [];
	await walk(root, root, paths);
	const snapshot = new Map<string, string>();
	for (const relative of paths) {
		if (!normalizeKnowledgePath(relative)) continue;
		try {
			const bytes = await Bun.file(path.join(root, ...relative.split("/"))).arrayBuffer();
			snapshot.set(relative, new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
		} catch {
			// A note removed between listing and hashing is simply absent.
		}
	}
	return snapshot;
}

/** Notes added, changed, or removed between two snapshots, sorted by path. */
export function diffKnowledgeSnapshots(before: KnowledgeSnapshot, after: KnowledgeSnapshot): KnowledgeChange[] {
	const changes: KnowledgeChange[] = [];
	for (const [notePath, hash] of after) {
		const previous = before.get(notePath);
		if (previous === undefined) changes.push({ path: notePath, kind: "created" });
		else if (previous !== hash) changes.push({ path: notePath, kind: "updated" });
	}
	for (const notePath of before.keys()) {
		if (!after.has(notePath)) changes.push({ path: notePath, kind: "deleted" });
	}
	return changes.sort((left, right) => left.path.localeCompare(right.path));
}
