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
 *     claims/<id>                         the omp session id working this issue
 *     sessions/<sessionId>                empty; its mtime is the session's heartbeat
 *     seen/<id>                           `updated` of the issue when last viewed
 *     seen/.watermark                     ISO time the inbox was first used
 *
 * No session takes an issue on its own: a claim is written only when the user
 * prompts a session to work the issue (it sets `stage: running`) or that session
 * hands it to the user with `stage: needs-you`, and from then
 * on that issue's replies and requeues go to the claiming session alone.
 *
 * Every take is atomic so parallel sessions never share work: a reply is taken
 * by renaming it to a dot-name (only one rename of a path can succeed), and a
 * claim is a hard link of a fully written temp file onto its name (only one
 * link can create the name, and readers never see a half-written holder).
 *
 * A session is live while its presence file was touched within
 * {@link PRESENCE_STALE_MS}. A claim naming a session that is not live is stale:
 * the next claimer moves it aside (one rename wins), checks it still names the
 * dead session, and links its own. Dot-files are in-flight temp, taken or
 * moved-aside entries and are never listed. Missing directories read as empty;
 * writers create them.
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

/**
 * Replace `file` with `content` atomically: a temp file in the same dir, then a
 * rename over the name. Last writer wins; a reader sees the old content or the
 * new one, never a partial write.
 */
async function replaceFile(file: string, content: string): Promise<void> {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	await fsp.writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
	await fsp.rename(tmp, file);
}

/**
 * Delete `file` only while it still names `holder`. The file is renamed to a
 * dot-name first (only one rename of a path can succeed), then checked: one
 * another session wrote since `holder` was read is linked back instead of
 * dropped. True when this call removed `holder`'s file.
 */
async function removeIfHeldBy(file: string, holder: string, actor: string): Promise<boolean> {
	const aside = path.join(
		path.dirname(file),
		`.${path.basename(file)}.${fileSafe(actor)}.${crypto.randomBytes(4).toString("hex")}.aside`,
	);
	try {
		await fsp.rename(file, aside);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	try {
		if ((await fsp.readFile(aside, "utf8")).trim() === holder) return true;
		try {
			await fsp.link(aside, file);
		} catch (error) {
			// A third session took the name meanwhile; its hold stands.
			if (errorCode(error) !== "EEXIST") throw error;
		}
		return false;
	} finally {
		await fsp.rm(aside, { force: true });
	}
}

/** mtime of `file` in epoch ms, or undefined when it does not exist. */
async function mtimeOf(file: string): Promise<number | undefined> {
	try {
		return (await fsp.stat(file)).mtimeMs;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Whether the claim in `file`, naming `holder`, can be taken over.
 *
 * A holder with a fresh heartbeat is live: the claim stands. A holder that
 * registered a heartbeat and let it go stale is gone: the claim is taken over at
 * once. A holder with no heartbeat at all is unknown, so the claim stands while
 * it is younger than the stale window — that keeps a session which writes its
 * presence and its claim in that order from losing the claim in between, and
 * keeps a claim exclusive while its holder is merely unregistered.
 */
async function holdIsStale(root: string, file: string, holder: string, now: number): Promise<boolean> {
	const beat = await mtimeOf(presenceFile(root, holder));
	if (beat !== undefined) return now - beat >= PRESENCE_STALE_MS;
	const heldAt = await mtimeOf(file);
	return heldAt === undefined || now - heldAt >= PRESENCE_STALE_MS;
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

/** The session that holds issue `id`, if any, live or not. */
export async function claimOwner(root: string, id: number): Promise<string | undefined> {
	const owner = (await readText(path.join(inboxDir(root), "claims", String(id))))?.trim();
	return owner ? owner : undefined;
}

/**
 * Claim issue `id` for `sessionId`. The holder is written to a temp file first
 * and hard-linked onto `claims/<id>`, which fails when the name exists, so the
 * create is exclusive and a reader never sees an empty holder. A claim whose
 * holder is no longer live is moved aside and the create retried. True when this
 * session holds the claim (new, already held, or taken over); false when another
 * live session does.
 */
export async function claim(root: string, id: number, sessionId: string): Promise<boolean> {
	const file = path.join(inboxDir(root), "claims", String(id));
	await fsp.mkdir(path.dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 5; attempt++) {
		const now = Date.now();
		if (await linkIntoPlace(file, sessionId)) return true;
		const holder = (await readText(file))?.trim();
		// Released between the failed link and the read: free again.
		if (holder === undefined) continue;
		if (holder === sessionId) return true;
		if (!(await holdIsStale(root, file, holder, now))) return false;
		await removeIfHeldBy(file, holder, sessionId);
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
		if (await removeIfHeldBy(file, sessionId, sessionId)) released += 1;
	}
	return released;
}

/** A session whose presence went this long without a refresh is gone: crashed, killed or suspended. */
export const PRESENCE_STALE_MS = 120_000;

function presenceFile(root: string, sessionId: string): string {
	return path.join(inboxDir(root), "sessions", fileSafe(sessionId));
}

/**
 * Bump the heartbeat of `sessionId`'s existing presence. False when it has none:
 * nothing is created, so a stray refresh never registers a session.
 */
export async function refreshPresence(root: string, sessionId: string): Promise<boolean> {
	const now = new Date();
	try {
		await fsp.utimes(presenceFile(root, sessionId), now, now);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Register `sessionId` as present in the checkout, or refresh its heartbeat. */
export async function touchPresence(root: string, sessionId: string): Promise<void> {
	if (await refreshPresence(root, sessionId)) return;
	await replaceFile(presenceFile(root, sessionId), "");
}

/** Drop `sessionId`'s presence: it reads as gone at once. */
export async function removePresence(root: string, sessionId: string): Promise<void> {
	await fsp.rm(presenceFile(root, sessionId), { force: true });
}

/** Whether `sessionId` refreshed its presence within {@link PRESENCE_STALE_MS} of `now`. */
export async function isLive(root: string, sessionId: string, now: number = Date.now()): Promise<boolean> {
	const beat = await mtimeOf(presenceFile(root, sessionId));
	return beat !== undefined && now - beat < PRESENCE_STALE_MS;
}

/**
 * Whether the claim on `id` is free to take: unclaimed, or held by a session that
 * is gone (see {@link holdIsStale}).
 */
export async function claimIsStale(root: string, id: number, now: number = Date.now()): Promise<boolean> {
	const file = path.join(inboxDir(root), "claims", String(id));
	const holder = (await readText(file))?.trim();
	if (holder === undefined || holder.length === 0) return true;
	return holdIsStale(root, file, holder, now);
}

/** Record that the user saw issue `id` as of `stamp` (the issue's `updated` when viewed). */
export async function markSeen(root: string, id: number, stamp: string): Promise<void> {
	// Last writer wins, and a reader sees either the old stamp or the new one.
	await replaceFile(path.join(inboxDir(root), "seen", String(id)), stamp);
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
