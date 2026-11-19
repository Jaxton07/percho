import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agent.dir,
}));
const { validateMcpServerConfig } = await import("@earendil-works/pi-coding-agent");
const { importMcpServers, listMcpServers, upsertMcpServer, removeMcpServer } = await import(
	"../src/mcp/config-store"
);
const sdkRoot = resolve(process.cwd(), "../../node_modules/@earendil-works/pi-coding-agent/dist");
const { loadMcpConfig } = (await import(join(sdkRoot, "extensions/mcp/config.js"))) as {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): { errors: string[] };
};
let root: string;
let cwd: string;
let path: string;
beforeAll(() => {
	const base = resolve(process.cwd(), "../../.local/tmp/review-mcp-status");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "config-"));
	agent.dir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agent.dir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	path = join(agent.dir, "mcp.json");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("MCP review regressions", () => {
	it("roundtrips legal prototype-like names through import, upsert and list", async () => {
		for (const name of ["__proto__", "constructor"]) {
			expect(typeof validateMcpServerConfig(name, { command: "node" })).not.toBe("string");
		}
		writeFileSync(path, '{"mcpServers":{}}');
		await importMcpServers({ json: '{"__proto__":{"command":"node"}}' }, { projectTrusted: false });
		await upsertMcpServer({ scope: "user", name: "constructor", command: "node" }, { projectTrusted: false });
		await upsertMcpServer(
			{ scope: "user", name: "__proto__", description: "updated" },
			{ projectTrusted: false },
		);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(Object.keys(saved.mcpServers).sort()).toEqual(["__proto__", "constructor"].sort());
		expect(Object.getOwnPropertyDescriptor(saved.mcpServers, "__proto__")?.value).toMatchObject({
			command: "node",
			description: "updated",
		});
		expect((await listMcpServers({ projectTrusted: false })).global.map((v) => v.name).sort()).toEqual(
			["__proto__", "constructor"].sort(),
		);
		writeFileSync(path, '{"mcpServers":{}}');
		await upsertMcpServer({ scope: "user", name: "__proto__", command: "node" }, { projectTrusted: false });
		await importMcpServers({ json: '{"constructor":{"command":"node"}}' }, { projectTrusted: false });
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers).sort()).toEqual(
			["__proto__", "constructor"].sort(),
		);
	});
	it("accepts BOM for SDK, both files, updates and pasted imports while rejecting corruption", async () => {
		writeFileSync(path, '\ufeff{"extra":1,"mcpServers":{"global":{"command":"node"}}}');
		const projectPath = join(cwd, ".pi/mcp.json");
		writeFileSync(projectPath, '\ufeff{"mcpServers":{"project":{"command":"node"}}}');
		expect(loadMcpConfig({ agentDir: agent.dir, cwd, projectTrusted: true }).errors).toEqual([]);
		const list = await listMcpServers({ cwd, projectTrusted: true });
		expect(list.errors).toEqual([]);
		expect(list.global.map((v) => v.name)).toEqual(["global"]);
		expect(list.project.map((v) => v.name)).toEqual(["project"]);
		await upsertMcpServer({ scope: "user", cwd, name: "global", enabled: false }, { projectTrusted: true });
		await upsertMcpServer(
			{ scope: "project", cwd, name: "project", enabled: false },
			{ projectTrusted: true },
		);
		await importMcpServers({ cwd, json: '\ufeff{"imported":{"command":"node"}}' }, { projectTrusted: true });
		writeFileSync(projectPath, '\ufeff{"mcpServers":{"project":{"command":"node"}}}');
		await removeMcpServer({ scope: "project", cwd, name: "project" });
		expect(JSON.parse(readFileSync(projectPath, "utf8")).mcpServers).toEqual({});
		expect(JSON.parse(readFileSync(path, "utf8")).extra).toBe(1);
		writeFileSync(path, "\ufeff{broken");
		await expect(
			upsertMcpServer({ scope: "user", name: "x", command: "node" }, { projectTrusted: false }),
		).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe("\ufeff{broken");
	});
	it("removes invalid entries one at a time without changing unrelated data or allowing bad updates", async () => {
		writeFileSync(
			path,
			JSON.stringify({
				extra: { keep: true },
				mcpServers: {
					"bad.name": { command: "node", custom: 1 },
					"bad name": { url: "nope", custom: 2 },
					good: { command: "node", custom: 3 },
				},
			}),
		);
		const before = readFileSync(path, "utf8");
		await expect(
			upsertMcpServer({ scope: "user", name: "new.bad", command: "node" }, { projectTrusted: false }),
		).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
		await removeMcpServer({ scope: "user", name: "bad.name" });
		let saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toEqual({
			extra: { keep: true },
			mcpServers: { "bad name": { url: "nope", custom: 2 }, good: { command: "node", custom: 3 } },
		});
		expect((await listMcpServers({ projectTrusted: false })).errors.length).toBeGreaterThan(0);
		await removeMcpServer({ scope: "user", name: "bad name" });
		saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toEqual({ extra: { keep: true }, mcpServers: { good: { command: "node", custom: 3 } } });
		await expect(
			upsertMcpServer(
				{ scope: "user", name: "bad", command: "node", url: "https://example.com" },
				{ projectTrusted: false },
			),
		).rejects.toThrow();
		await expect(
			upsertMcpServer({ scope: "user", name: "bad.name", command: "node" }, { projectTrusted: false }),
		).rejects.toThrow();
	});
});
