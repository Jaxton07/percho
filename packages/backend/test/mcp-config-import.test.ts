import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agent.dir,
}));
const { importMcpServers, listMcpServers, upsertMcpServer, removeMcpServer } = await import(
	"../src/mcp/config-store"
);
let root: string;
let cwd: string;
let path: string;
beforeAll(() => {
	const base = resolve(process.cwd(), "../../.local/tmp");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "mcp-import-"));
	agent.dir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agent.dir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	path = join(agent.dir, "mcp.json");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("atomic MCP import and overrides", () => {
	it("rejects the whole invalid batch and retains raw fields on success", async () => {
		writeFileSync(
			path,
			JSON.stringify({
				autoEnableCodemode: true,
				extra: 1,
				mcpServers: { old: { command: "node", env: { A: "B" } } },
			}),
		);
		const before = readFileSync(path, "utf8");
		await expect(
			importMcpServers(
				{ json: JSON.stringify({ good: { command: "node" }, bad: 3 }), cwd },
				{ projectTrusted: true },
			),
		).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
		await importMcpServers(
			{
				json: JSON.stringify({
					mcpServers: {
						old: { command: "node", env: { X: "Y" }, custom: 42 },
						remote: { url: "https://example.com", headers: { token: "value" } },
					},
				}),
				cwd,
			},
			{ projectTrusted: true },
		);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			autoEnableCodemode: true,
			extra: 1,
			mcpServers: {
				old: { env: { X: "Y" }, custom: 42, exposure: "deferred" },
				remote: { headers: { token: "value" }, exposure: "deferred" },
			},
		});
	});
	it("serializes global and project mutations before validating", async () => {
		writeFileSync(path, JSON.stringify({ mcpServers: {} }));
		writeFileSync(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: {} }));
		const results = await Promise.allSettled([
			upsertMcpServer({ scope: "user", cwd, name: "a-b", command: "node" }, { projectTrusted: true }),
			upsertMcpServer({ scope: "project", cwd, name: "a_b", command: "node" }, { projectTrusted: true }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect((await listMcpServers({ cwd, projectTrusted: true })).errors).toEqual([]);
	});
	it("preserves override source and shows invalid entries", async () => {
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: { old: { command: "node", enabled: false, exposure: "direct" }, invalid: 3 },
			}),
		);
		writeFileSync(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: { old: { exposure: "hidden" } } }));
		const list = await listMcpServers({ cwd, projectTrusted: true });
		expect(list.global.find((v) => v.name === "invalid")?.transport.kind).toBe("unknown");
		expect(list.project[0]).toMatchObject({
			isOverride: true,
			enabled: false,
			exposure: "hidden",
			transport: { kind: "stdio" },
		});
		writeFileSync(path, JSON.stringify({ mcpServers: { old: { command: "node" } } }));
		await upsertMcpServer({ scope: "project", cwd, name: "old", enabled: false }, { projectTrusted: true });
		expect(JSON.parse(readFileSync(join(cwd, ".pi/mcp.json"), "utf8")).mcpServers.old).toEqual({
			exposure: "hidden",
			enabled: false,
		});
		await expect(removeMcpServer({ scope: "project", name: "old" })).rejects.toThrow();
	});
});
