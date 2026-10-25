/**
 * The plugin's `agents/*.md` must land in the task tool's agent roster, and only
 * while the plugin root is in the effective extension roots — these agents are
 * no longer bundled in the host package.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const SHIPPED = ["research", "solver", "tester"] as const;

let cwd: string;
let home: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-cwd-"));
	home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-home-"));
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
	await fs.rm(home, { recursive: true, force: true });
});

function roots(explicit: readonly string[]): EffectiveExtensionRoots {
	return { explicit, configured: [], configuredLevel: "user", mode: "explicit-only" };
}

async function names(extensionRoots: EffectiveExtensionRoots): Promise<string[]> {
	const result = await discoverAgents(cwd, home, extensionRoots);
	return result.agents.map(agent => agent.name);
}

describe("omp-agents plugin", () => {
	it("publishes solver, research, and tester to discovery", async () => {
		const found = await names(roots([PLUGIN_ROOT]));
		for (const name of SHIPPED) expect(found).toContain(name);
	});

	it("no longer ships from the host package — the roster has none of them without the plugin root", async () => {
		const found = (await discoverAgents(cwd, home, roots([]))).agents.map(agent => agent.name);
		for (const name of SHIPPED) expect(found).not.toContain(name);
	});

	it("resolves every shipped agent from the plugin's own agents/ directory", async () => {
		const found = (await discoverAgents(cwd, home, roots([PLUGIN_ROOT]))).agents;
		const agentsDir = path.join(PLUGIN_ROOT, "agents");

		for (const name of SHIPPED) {
			const agent = found.find(candidate => candidate.name === name);
			expect(agent?.source).not.toBe("bundled");
			expect(agent?.filePath === undefined ? "" : path.dirname(agent.filePath)).toBe(agentsDir);
		}
	});

	it("keeps research restricted to web tools — no repo, file, or command access", async () => {
		const research = (await discoverAgents(cwd, home, roots([PLUGIN_ROOT]))).agents.find(a => a.name === "research");
		expect(research).toBeDefined();
		expect(research?.source).toBe("user");
		const tools = research?.tools ?? [];

		// The defining guarantee: research reasons from the web only.
		expect(tools).toContain("web_search");
		expect(tools).toContain("browser");
		for (const forbidden of ["read", "write", "edit", "bash", "search", "find", "lsp", "ast_grep", "ast_edit"]) {
			expect(tools).not.toContain(forbidden);
		}
	});

	it("keeps the fork's model roles and thinking level in the shipped frontmatter", async () => {
		const agents = (await discoverAgents(cwd, home, roots([PLUGIN_ROOT]))).agents;
		const modelOf = (name: string): string[] | undefined => agents.find(agent => agent.name === name)?.model;

		expect(modelOf("solver")).toEqual(["pi/solver"]);
		expect(modelOf("research")).toEqual(["pi/research"]);
		expect(modelOf("tester")).toEqual(["pi/task"]);

		const testerLevel: string | undefined = agents.find(agent => agent.name === "tester")?.thinkingLevel;
		expect(testerLevel).toBe("high");
	});
});
