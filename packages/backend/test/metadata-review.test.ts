import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type McpRuntimeInventory, projectMcpRuntime } from "@percho/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agent.dir,
}));
const { listMcpServers } = await import("../src/mcp/config-store");
const sdkRoot = resolve(process.cwd(), "../../node_modules/@earendil-works/pi-coding-agent/dist");
const { loadMcpConfig } = (await import(join(sdkRoot, "extensions/mcp/config.js"))) as {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
		errors: string[];
		servers: { name: string; source: string; override?: string }[];
	};
};
let root: string;
let cwd: string;
let globalPath: string;
let projectPath: string;
beforeAll(() => {
	const base = resolve(process.cwd(), "../../.local/tmp/metadata-review");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "fixture-"));
	agent.dir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agent.dir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	globalPath = join(agent.dir, "mcp.json");
	projectPath = join(cwd, ".pi", "mcp.json");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("keeps configured enabled across repeated projections and live instance removal", async () => {
	writeFileSync(
		globalPath,
		JSON.stringify({ mcpServers: { one: { command: "node" }, two: { command: "node", enabled: false } } }),
	);
	writeFileSync(projectPath, "{}");
	const config = { ...(await listMcpServers({ cwd, projectTrusted: true })), contextCwd: cwd };
	const live: McpRuntimeInventory = {
		epoch: "e",
		revision: 1,
		instances: [
			{
				instanceId: "i",
				sessionId: "s",
				cwd,
				available: true,
				errors: [],
				servers: [
					{ name: "one", source: globalPath, state: "disabled", tools: [] },
					{ name: "two", source: globalPath, state: "connected", tools: [] },
				],
			},
		],
	};
	const projected = projectMcpRuntime(config, live);
	expect(projected.global.map((v) => v.enabled)).toEqual([false, true]);
	const removed = projectMcpRuntime(projected, { ...live, instances: [] });
	expect(removed.global.map((v) => [v.enabled, v.state, v.configuredEnabled])).toEqual([
		[true, "not-started", true],
		[false, "disabled", false],
	]);
});

it("uses SDK-valid project override metadata despite unrelated errors and respects live source", async () => {
	writeFileSync(
		globalPath,
		'\ufeff{"mcpServers":{"__proto__":{"command":"node"},"constructor":{"command":"node"},"bad.name":{"command":"node"},"collision-name":{"command":"node"},"collision_name":{"command":"node"}}}',
	);
	writeFileSync(
		projectPath,
		'\ufeff{"mcpServers":{"__proto__":{"enabled":false},"constructor":{"command":"other"},"collision_name":{"enabled":false}}}',
	);
	const official = loadMcpConfig({ agentDir: agent.dir, cwd, projectTrusted: true });
	const config = { ...(await listMcpServers({ cwd, projectTrusted: true })), contextCwd: cwd };
	expect(config.errors.length).toBe(official.errors.length);
	for (const name of ["__proto__", "constructor", "collision_name"]) {
		const effective = official.servers.find((s) => s.name === name);
		const overridden =
			!!effective &&
			(effective.override ?? effective.source) === projectPath &&
			config.global.some((s) => s.name === name);
		expect(config.project.find((s) => s.name === name)?.overridesGlobal).toBe(overridden);
	}
	expect(config.project.find((s) => s.name === "collision_name")?.isOverride).not.toBe(true);
	expect(config.project.find((s) => s.name === "__proto__")).toMatchObject({
		isOverride: true,
		enabled: false,
		transport: { kind: "stdio", command: "node" },
	});
	const empty: McpRuntimeInventory = { epoch: "e", revision: 1, instances: [] };
	const staticView = projectMcpRuntime(config, empty);
	expect(staticView.global.find((s) => s.name === "__proto__")?.state).toBe("overridden");
	expect(staticView.global.find((s) => s.name === "constructor")?.state).toBe("overridden");
	expect(staticView.global.find((s) => s.name === "collision_name")?.state).not.toBe("overridden");
	const live: McpRuntimeInventory = {
		...empty,
		instances: [
			{
				instanceId: "i",
				sessionId: "s",
				cwd,
				available: true,
				errors: [],
				servers: [{ name: "__proto__", source: globalPath, state: "connected", tools: [] }],
			},
		],
	};
	expect(projectMcpRuntime(config, live).global.find((s) => s.name === "__proto__")?.state).toBe("connected");
	const unavailable = { ...live, instances: [{ ...live.instances[0], available: false }] };
	expect(projectMcpRuntime(config, unavailable).global.find((s) => s.name === "__proto__")?.state).toBe(
		"overridden",
	);
	const legacy = {
		...config,
		errors: [],
		project: config.project.map(({ overridesGlobal: _, ...view }) => view),
	};
	expect(projectMcpRuntime(legacy, empty).global.find((s) => s.name === "__proto__")?.state).toBe(
		"overridden",
	);
});
