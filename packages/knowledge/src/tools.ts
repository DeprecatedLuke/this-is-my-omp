/**
 * Host settings + agent plumbing for the plugin's headless passes: the host's
 * own `Settings` instance, a minimal `ToolSession` bound to a pass directory,
 * the tool sets a pass may use, and the secret-obfuscation seam the host
 * applies to outbound provider context.
 */
import type { AgentOptions } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { buildSecretObfuscator, type SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { cfgSecretsEnabled } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";

/** Heterogeneous tool list, spelled the way {@link AgentOptions} declares it. */
export type PassTools = NonNullable<AgentOptions["initialState"]>["tools"];

/** The host's initialized settings; the plugin registers no settings of its own. */
export async function hostSettings(): Promise<Settings> {
	const pending = Settings.current;
	if (pending) return await pending;
	return await Settings.init({ cwd: getProjectDir() });
}

/**
 * Minimal {@link ToolSession} for a headless pass. `read`/`write`/`edit` resolve
 * `knowledge://` against `cwd` (their bound session), so only the required
 * fields plus `settings` are needed; LSP stays off.
 */
export function createPassToolSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

/** Tools a knowledge pass may use, by name, bound to `cwd`. */
export function createPassTools(cwd: string, settings: Settings, names: readonly string[]): PassTools {
	const session = createPassToolSession(cwd, settings);
	const tools: PassTools = [];
	for (const name of names) {
		switch (name) {
			case "read":
				tools.push(new ReadTool(session));
				break;
			case "write":
				tools.push(new WriteTool(session));
				break;
			case "edit":
				tools.push(new EditTool(session));
				break;
			case "grep":
				tools.push(new GrepTool(session));
				break;
			case "glob":
				tools.push(new GlobTool(session));
				break;
			case "bash":
				tools.push(new BashTool(session));
				break;
			default:
				throw new Error(`Unknown knowledge pass tool: ${name}`);
		}
	}
	return tools;
}

/** The knowledge base is only reachable through `knowledge://`, so these are always granted. */
export const NOTE_TOOLS = ["read", "write", "edit"] as const;

/** Maintenance passes additionally inspect the repository and delete redundant notes. */
export const MAINTENANCE_TOOLS = [...NOTE_TOOLS, "grep", "glob", "bash"] as const;

/**
 * Outbound secret redaction for a pass that runs in this process, mirroring the
 * host's session behavior so a note can never capture a live credential.
 * Undefined when secret handling is off or nothing is configured.
 */
export async function buildPassObfuscator(cwd: string, settings: Settings): Promise<SecretObfuscator | undefined> {
	if (!cfgSecretsEnabled.get(settings)) return undefined;
	try {
		const obfuscator = await buildSecretObfuscator(cwd, getAgentDir());
		return obfuscator?.obfuscates() ? obfuscator : undefined;
	} catch {
		return undefined;
	}
}
