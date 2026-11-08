/**
 * The user-local issue inbox: runtime state that must never be committed.
 *
 * `.omp/issues` is tracked by git, so anything a session or the board writes
 * there travels with the repo. Pending `omp-board` replies, "queued by the user"
 * marks, session claims and what the user has already seen are machine-local
 * instructions and locks, so they live under the agent dir instead, one
 * directory per checkout:
 *
 *   ~/.omp/agent/issues-inbox/<slug>-<hash>/
 *     replies/<id>/<epochMs>-<rand>.txt   one pending reply per file
 *     queued/<id>                         empty: the user queued this issue
 *     claims/<id>                         the owning omp session id
 *     seen/<id>                           `updated` of the issue when last viewed
 *     seen/.watermark                     ISO time the inbox was first used
 *
 * Every take is atomic so parallel sessions never share work: a reply is taken
 * by renaming it to a dot-name (only one rename of a path can succeed), and a
 * claim is a hard link of a fully written temp file onto `claims/<id>` (only
 * one link can create the name, and readers never see a half-written owner).
 * Dot-files are in-flight temp or taken entries and are never listed. Missing
 * directories read as empty; writers create them.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";

const REPLY_FILE_RE = /^(\d+)-[0-9a-f]+\.txt$/;
const ID_RE = /^\d+$/;

/** One reply typed on the board and not yet delivered to an agent. */
export interface PendingReply {
	id: number;
	/** Absolute path of the reply file. */
	file: string;
	text: string;
	/** ISO time the reply was queued, from the file name's epoch ms. */
	at: string;
}

/** What the user has already looked at on the board, plus the inbox watermark. */
export interface SeenState {
	/** ISO time the inbox was created; archived issues older than it count as seen. */
	watermark: string;
	/** Seen stamp (`updated` of the issue when viewed) by issue id. */
	seen: Map<number, string>;
}

function canonicalRoot(root: string): string {
	try {
		return fs.realpathSync(root);
	} catch {
		return path.resolve(root);
	}
}

function slug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "root"
	);
}

/** The inbox directory of the checkout rooted at `root` (the dir holding `.omp/issues`). */
export function inboxDir(root: string): string {
	const real = canonicalRoot(root);
	const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), "issues-inbox", `${slug(path.basename(real))}-${hash}`);
}

/** A session id made safe for a file name. */
function fileSafe(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "session";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

async function readDirNames(dir: string): Promise<string[]> {
	try {
		return await fsp.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await fsp.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Drop an emptied per-issue reply dir; a concurrent writer recreates it. */
async function pruneDir(dir: string): Promise<void> {
	try {
		await fsp.rmdir(dir);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	}
}

/**
 * Write `content` to `file` atomically: a temp file in the same dir, then a hard
 * link onto the name, which fails when the name already exists. Returns false
 * when the name was taken. Readers never observe a partially written file.
 */
async function linkIntoPlace(file: string, content: string): Promise<boolean> {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	await fsp.writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
	try {
		await fsp.link(tmp, file);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		await fsp.rm(tmp, { force: true });
	}
}

/** Queue one reply for issue `id`: written to a temp file in the same dir, then renamed into place. */
export async function addReply(root: string, id: number, text: string): Promise<PendingReply> {
	const trimmed = text.trim();
	if (trimmed.length === 0) throw new Error("Reply is empty.");
	const dir = path.join(inboxDir(root), "replies", String(id));
	const epoch = Date.now();
	const name = `${epoch}-${crypto.randomBytes(6).toString("hex")}.txt`;
	const file = path.join(dir, name);
	const tmp = path.join(dir, `.${name}.tmp`);
	// A concurrent take may prune the dir between mkdir and write; recreate and retry.
	for (let attempt = 0; ; attempt++) {
		await fsp.mkdir(dir, { recursive: true });
		try {
			await fsp.writeFile(tmp, trimmed, { encoding: "utf8", flag: "wx" });
			break;
		} catch (error) {
			if (!isEnoent(error) || attempt >= 4) throw error;
		}
	}
	await fsp.rename(tmp, file);
	return { id, file, text: trimmed, at: new Date(epoch).toISOString() };
}

/** Every pending reply, oldest first. */
export async function listReplies(root: string): Promise<PendingReply[]> {
	const base = path.join(inboxDir(root), "replies");
	const out: { reply: PendingReply; epoch: number; name: string }[] = [];
	for (const idName of await readDirNames(base)) {
		if (!ID_RE.test(idName)) continue;
		const id = Number(idName);
		const dir = path.join(base, idName);
		for (const name of await readDirNames(dir)) {
			const match = name.match(REPLY_FILE_RE);
			if (!match) continue;
			const file = path.join(dir, name);
			const text = await readText(file);
			// Taken by another session since the readdir.
			if (text === undefined) continue;
			const epoch = Number(match[1]);
			out.push({ reply: { id, file, text, at: new Date(epoch).toISOString() }, epoch, name });
		}
	}
	out.sort((a, b) => a.epoch - b.epoch || a.reply.id - b.reply.id || a.name.localeCompare(b.name));
	return out.map(entry => entry.reply);
}

/**
 * Take one reply for `sessionId`: rename it to a dot-name (only one session's
 * rename can succeed), read it, delete it. Undefined when another session took
 * it first.
 */
export async function takeReply(root: string, reply: PendingReply, sessionId: string): Promise<string | undefined> {
	// The inbox owns the layout, so the file is addressed from `root` rather than
	// trusted from the caller's path.
	const dir = path.join(inboxDir(root), "replies", String(reply.id));
	const file = path.join(dir, path.basename(reply.file));
	const taken = path.join(
		dir,
		`.${path.basename(file)}.${fileSafe(sessionId)}.${crypto.randomBytes(4).toString("hex")}.taken`,
	);
	try {
		await fsp.rename(file, taken);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const text = await fsp.readFile(taken, "utf8");
	await fsp.rm(taken, { force: true });
	await pruneDir(dir);
	return text;
}

/** Mark (or unmark) issue `id` as queued by the user on this machine. */
export async function setQueued(root: string, id: number, queued: boolean): Promise<void> {
	const file = path.join(inboxDir(root), "queued", String(id));
	if (!queued) {
		await fsp.rm(file, { force: true });
		return;
	}
	await fsp.mkdir(path.dirname(file), { recursive: true });
	await fsp.writeFile(file, "");
}

/** Ids of every issue the user queued on this machine. */
export async function listQueued(root: string): Promise<Set<number>> {
	const ids = new Set<number>();
	for (const name of await readDirNames(path.join(inboxDir(root), "queued"))) {
		if (ID_RE.test(name)) ids.add(Number(name));
	}
	return ids;
}

/** The session that holds issue `id`, if any. */
export async function claimOwner(root: string, id: number): Promise<string | undefined> {
	const owner = (await readText(path.join(inboxDir(root), "claims", String(id))))?.trim();
	return owner ? owner : undefined;
}

/**
 * Claim issue `id` for `sessionId`. The owner is written to a temp file first
 * and hard-linked onto `claims/<id>`, which fails when the name exists, so the
 * create is exclusive and a reader never sees an empty owner. True when this
 * session owns the claim (new, or already held); false when another session does.
 */
export async function claim(root: string, id: number, sessionId: string): Promise<boolean> {
	const file = path.join(inboxDir(root), "claims", String(id));
	await fsp.mkdir(path.dirname(file), { recursive: true });
	// A claim released between a failed link and the owner read is free again: retry.
	for (let attempt = 0; attempt < 5; attempt++) {
		if (await linkIntoPlace(file, sessionId)) return true;
		const owner = await claimOwner(root, id);
		if (owner !== undefined) return owner === sessionId;
	}
	return false;
}

/** Free the claim on issue `id`, whoever holds it. */
export async function releaseClaim(root: string, id: number): Promise<void> {
	await fsp.rm(path.join(inboxDir(root), "claims", String(id)), { force: true });
}

/** Free every claim `sessionId` holds; returns how many were freed. */
export async function releaseSessionClaims(root: string, sessionId: string): Promise<number> {
	const dir = path.join(inboxDir(root), "claims");
	let released = 0;
	for (const name of await readDirNames(dir)) {
		if (!ID_RE.test(name)) continue;
		const file = path.join(dir, name);
		if ((await readText(file))?.trim() !== sessionId) continue;
		// Move it aside before deleting, so a claim another session took between the
		// read and the delete is put back instead of silently dropped.
		const aside = path.join(dir, `.${name}.${fileSafe(sessionId)}.${crypto.randomBytes(4).toString("hex")}.release`);
		try {
			await fsp.rename(file, aside);
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		try {
			if ((await fsp.readFile(aside, "utf8")).trim() === sessionId) {
				released += 1;
				continue;
			}
			try {
				await fsp.link(aside, file);
			} catch (error) {
				// A third session claimed it meanwhile; its claim stands.
				if (errorCode(error) !== "EEXIST") throw error;
			}
		} finally {
			await fsp.rm(aside, { force: true });
		}
	}
	return released;
}

/** Record that the user saw issue `id` as of `stamp` (the issue's `updated` when viewed). */
export async function markSeen(root: string, id: number, stamp: string): Promise<void> {
	const file = path.join(inboxDir(root), "seen", String(id));
	await fsp.mkdir(path.dirname(file), { recursive: true });
	// Last writer wins, and a reader sees either the old stamp or the new one.
	const tmp = path.join(path.dirname(file), `.${id}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	await fsp.writeFile(tmp, stamp, { encoding: "utf8", flag: "wx" });
	await fsp.rename(tmp, file);
}

/**
 * Seen stamps by id plus the inbox watermark. The first call for a root writes
 * `seen/.watermark` = now, so the archived issues already there count as seen
 * instead of flooding the board's Finished section.
 */
export async function loadSeen(root: string): Promise<SeenState> {
	const dir = path.join(inboxDir(root), "seen");
	await fsp.mkdir(dir, { recursive: true });
	const watermarkFile = path.join(dir, ".watermark");
	let watermark = await readText(watermarkFile);
	// A concurrent first call may be mid-write; the link makes the content complete.
	for (let attempt = 0; watermark === undefined && attempt < 5; attempt++) {
		watermark = (await linkIntoPlace(watermarkFile, new Date().toISOString()))
			? await readText(watermarkFile)
			: await readText(watermarkFile);
	}
	const seen = new Map<number, string>();
	for (const name of await readDirNames(dir)) {
		if (!ID_RE.test(name)) continue;
		const stamp = (await readText(path.join(dir, name)))?.trim();
		if (stamp) seen.set(Number(name), stamp);
	}
	return { watermark: watermark ?? new Date(0).toISOString(), seen };
}
