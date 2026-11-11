/**
 * The board's writes: a state move, a reply, and marking an issue as seen.
 *
 * The TUI (`board.ts`) and the JSON API (`api.ts`) both drive the same store
 * calls, so they live here once and each returns the footer text the TUI shows:
 * a keypress and an `omp-board api move` say the same thing.
 */
import { markSeen, type PendingReply, releaseClaim, setQueued } from "omp-issues/src/inbox";
import { type IssueRecord, moveIssue, replyToIssue } from "omp-issues/src/store";
import { type BoardStateId, type DoneStatus, liveHolder, moveFor, shortSession, stateTitle } from "./model";

/** A state move: the record the store wrote, and what the footer says about it. */
export interface MoveResult {
	record: IssueRecord;
	/** `#12 → Up next · stays with session aaaaaa`. */
	message: string;
}

/** A queued reply: the reopened record, the pending reply, and the footer text. */
export interface ReplyResult {
	record: IssueRecord;
	reply: PendingReply;
	/** `#12 reply queued for session aaaaaa` or `#12 reply waits until a session takes the issue`. */
	message: string;
}

/** Footer text of a move to `state`; `holder` is the live session keeping the issue. */
export function moveMessage(id: number, state: BoardStateId, holder: string | undefined): string {
	const suffix = holder === undefined ? "" : ` · stays with session ${shortSession(holder)}`;
	return `#${id} → ${stateTitle(state)}${suffix}`;
}

/**
 * Move issue `record` to `state`, then report it. Done ends the work, so its
 * claim goes; any other move keeps the issue with the session that holds it: a
 * requeue or a later reply goes back to the session with the context, and an
 * issue no session holds waits for one to be prompted to take it. Only a move to
 * Up next queues it for this machine's agents.
 */
export async function moveIssueTo(
	root: string,
	record: IssueRecord,
	state: BoardStateId,
	doneStatus?: DoneStatus,
	remarks?: string,
): Promise<MoveResult> {
	const id = record.id;
	const moved = await moveIssue(root, id, moveFor(state, record, doneStatus, remarks));
	if (state === "done") await releaseClaim(root, id);
	await setQueued(root, id, state === "up-next");
	const holder = state === "done" ? undefined : await liveHolder(root, id);
	return { record: moved, message: moveMessage(id, state, holder) };
}

/**
 * Queue `text` as the user's reply to issue `id`. The store moves the issue back
 * to Up next (unarchiving it), which is the "back to unsolved" path.
 */
export async function replyToBoardIssue(root: string, id: number, text: string): Promise<ReplyResult> {
	const { record, reply } = await replyToIssue(root, id, text);
	const holder = await liveHolder(root, id);
	const message =
		holder === undefined
			? `#${id} reply waits until a session takes the issue`
			: `#${id} reply queued for session ${shortSession(holder)}`;
	return { record, reply, message };
}

/**
 * Record that the user looked at `record` as of its current `updated`. Returns
 * that stamp, or undefined when the issue carries none and there is nothing to
 * record.
 */
export async function markIssueSeen(root: string, record: IssueRecord): Promise<string | undefined> {
	const stamp = record.frontmatter.updated;
	if (stamp === undefined) return undefined;
	await markSeen(root, record.id, stamp);
	return stamp;
}
