/**
 * Plugin settings. Declared under `omp.settings` in package.json; the host
 * reader returns only what the user configured, so every default lives here.
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

/** Plugin id: the key `/plugins` and `omp plugin config` use for `omp.settings`. */
export const PLUGIN_NAME = "omp-knowledge";

/** Provider tokens a main session may accumulate before the reminder (the core default). */
export const DEFAULT_REMINDER_THRESHOLD_TOKENS = 100_000;

export interface KnowledgeSettings {
	/**
	 * Non-cached provider work (`input + output + cacheWrite`) a top-level
	 * session may accumulate before the agent is reminded to catalogue what it
	 * learned. `0` or a negative value disables the reminder.
	 */
	reminderThresholdTokens: number;
}

function coerceNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

/** Merged global + project settings for this plugin, defaults applied. */
export async function loadKnowledgeSettings(cwd: string): Promise<KnowledgeSettings> {
	let raw: Record<string, unknown> = {};
	try {
		raw = await getPluginSettings(PLUGIN_NAME, cwd);
	} catch {
		// Unreadable plugin config: fall back to defaults rather than break the session.
	}
	return {
		reminderThresholdTokens: coerceNumber(raw.reminderThresholdTokens, DEFAULT_REMINDER_THRESHOLD_TOKENS),
	};
}
