/**
 * End-of-turn knowledge reminder contract: the decision (threshold crossing,
 * main-agent only, watermarking so the same work is offered once) and the text
 * the model sees.
 */
import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai/types";
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	collectUncataloguedWork,
	decideKnowledgeReminder,
	KNOWLEDGE_WATERMARK_CUSTOM_TYPE,
	renderKnowledgeReminder,
} from "../src/reminder";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

interface AssistantUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

function assistantMessage(usageOrOutput: number | AssistantUsage): Message {
	const usage =
		typeof usageOrOutput === "number" ? { output: usageOrOutput, totalTokens: usageOrOutput } : usageOrOutput;
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			...usage,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as Message;
}

function userMessage(): Message {
	return { role: "user", content: [{ type: "text", text: "question" }], timestamp: 0 };
}

function messageEntry(id: string, message: Message): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: TIMESTAMP, message };
}

/** What `pi.appendEntry` writes; `data` absent reproduces pre-reminder sessions. */
function watermarkEntry(id: string, data?: unknown): CustomEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		customType: KNOWLEDGE_WATERMARK_CUSTOM_TYPE,
		data,
	};
}

function decide(entries: readonly SessionEntry[], thresholdTokens: number, agentKind: "main" | "sub" = "main") {
	return decideKnowledgeReminder({ entries, thresholdTokens, agentKind, busy: false });
}

describe("decideKnowledgeReminder", () => {
	const work: SessionEntry[] = [
		messageEntry("m1", userMessage()),
		messageEntry("m2", assistantMessage(6)),
		messageEntry("m3", assistantMessage(4)),
	];

	it("declines below the threshold and once the threshold is reached", () => {
		expect(decide(work, 11)).toBeUndefined();
		expect(decide(work, 10)).toEqual({ totalTokens: 10, watermark: { throughEntryId: "m3" } });
	});

	it("never reminds a subagent or while a /knowledge pass owns the notes", () => {
		expect(decide(work, 1, "sub")).toBeUndefined();
		expect(
			decideKnowledgeReminder({ entries: work, thresholdTokens: 1, agentKind: "main", busy: true }),
		).toBeUndefined();
	});

	it("treats a zero, negative, NaN, or infinite threshold as disabled", () => {
		for (const thresholdTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(decide(work, thresholdTokens)).toBeUndefined();
		}
	});

	it("declines when the watermark already covers every message", () => {
		expect(decide([...work, watermarkEntry("mark", { throughEntryId: "m3" })], 1)).toBeUndefined();
	});

	it("fires once per crossing: the watermark it returns silences the same work", () => {
		const plan = decide(work, 10);
		expect(plan).toBeDefined();
		const afterReminder = [...work, watermarkEntry("mark", plan?.watermark)];
		expect(decide(afterReminder, 10)).toBeUndefined();
	});

	it("re-arms after another threshold's worth of work arrives past the watermark", () => {
		const afterReminder = [...work, watermarkEntry("mark", { throughEntryId: "m3" })];
		const more: SessionEntry[] = [messageEntry("m4", assistantMessage(9)), messageEntry("m5", assistantMessage(1))];
		expect(decide([...afterReminder, ...more], 10)).toEqual({
			totalTokens: 10,
			watermark: { throughEntryId: "m5" },
		});
	});

	it("honors a legacy marker that carries no throughEntryId by resetting at its position", () => {
		const entries: SessionEntry[] = [
			messageEntry("old-user", userMessage()),
			messageEntry("old-assistant", assistantMessage(40)),
			watermarkEntry("legacy-mark"),
			messageEntry("new-user", userMessage()),
			messageEntry("new-assistant", assistantMessage(3)),
		];
		expect(decide(entries, 10)).toBeUndefined();
		expect(decide(entries, 3)).toEqual({ totalTokens: 3, watermark: { throughEntryId: "new-assistant" } });
	});

	it("honors a legacy throughEntryId watermark while keeping work that arrived after it", () => {
		const entries: SessionEntry[] = [
			messageEntry("processed", assistantMessage(40)),
			watermarkEntry("legacy-mark", { throughEntryId: "processed" }),
			messageEntry("pending", assistantMessage(7)),
		];
		expect(decide(entries, 10)).toBeUndefined();
		expect(decide(entries, 7)).toEqual({ totalTokens: 7, watermark: { throughEntryId: "pending" } });
	});
});

describe("collectUncataloguedWork", () => {
	it("counts only non-cached provider work (input + output + cacheWrite)", () => {
		const work = collectUncataloguedWork([
			messageEntry(
				"cache-heavy",
				assistantMessage({ input: 2, output: 3, cacheRead: 133_000, cacheWrite: 5, totalTokens: 133_010 }),
			),
			messageEntry("negative", assistantMessage(-4)),
			messageEntry("nan", assistantMessage(Number.NaN)),
		]);

		expect(work.messages.map(entry => entry.id)).toEqual(["cache-heavy", "negative", "nan"]);
		expect(work.totalTokens).toBe(10);
	});
});

describe("renderKnowledgeReminder", () => {
	it("names the token count and points at the knowledge scheme", () => {
		const text = renderKnowledgeReminder(100_000);
		expect(text).toContain("100,000 tokens");
		expect(text).toContain("knowledge://<category>/<topic>.md");
	});
});
