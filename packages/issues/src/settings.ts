/**
 * Plugin settings for the issue tracker.
 *
 * `package.json#omp.settings` declares the schema for `omp plugin config`; the
 * reader returns only the keys the user actually set, so every default lives
 * here. Defaults mirror the `issues.*` core settings this feature was moved out
 * of (`enabled` and `reminders` on, three reminders per prompt).
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

/** Plugin name, as `omp plugin` registers it and settings are keyed. */
export const PLUGIN_NAME = "omp-issues";

export interface IssuesSettings {
	/** Enable the project-local issues tool. */
	enabled: boolean;
	/** Remind the agent before it ends a turn while issues are still in-progress. */
	reminders: boolean;
	/** Maximum number of reminders per prompt. */
	remindersMax: number;
}

const DEFAULT_SETTINGS: IssuesSettings = { enabled: true, reminders: true, remindersMax: 3 };

/**
 * Read the issues plugin settings for `cwd`, with project overrides applied.
 * Unreadable config falls back to the defaults: a broken settings file must
 * never cost the session its tracker.
 */
export async function readIssuesSettings(cwd: string): Promise<IssuesSettings> {
	let raw: Record<string, unknown>;
	try {
		raw = await getPluginSettings(PLUGIN_NAME, cwd);
	} catch {
		return DEFAULT_SETTINGS;
	}
	const max = raw.remindersMax;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
		reminders: typeof raw.reminders === "boolean" ? raw.reminders : DEFAULT_SETTINGS.reminders,
		remindersMax:
			typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_SETTINGS.remindersMax,
	};
}
