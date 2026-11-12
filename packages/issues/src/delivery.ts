import { type PendingReply, takeReply } from "./inbox";
import type { DeliveredReply } from "./replies";
import { appendReplyHistory } from "./store";

/** Where a failed take or history write is reported; delivery itself never fails. */
type DeliveryLog = (message: string, context: { id: number; error: string }) => void;

/**
 * Take a caller-authorized, oldest-first inbox snapshot and record each delivered
 * text in its issue history. Atomic taking chooses one consumer; a history write
 * failure must never discard text already taken for that consumer's result.
 */
export async function takeReplies(
	root: string,
	replies: readonly PendingReply[],
	sessionId: string,
	logger?: DeliveryLog,
): Promise<DeliveredReply[]> {
	const taken: DeliveredReply[] = [];
	for (const reply of replies) {
		let text: string | undefined;
		try {
			text = await takeReply(root, reply, sessionId);
		} catch (error) {
			logger?.("issues: failed to take a pending reply", {
				id: reply.id,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (text === undefined) continue;
		taken.push({ text, at: reply.at });
		try {
			await appendReplyHistory(root, reply.id, text, reply.at);
		} catch (error) {
			logger?.("issues: failed to record a delivered reply", {
				id: reply.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return taken;
}
