import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateMcpServerConfig } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateMcpConfigs } from "../src/mcp/config-validation";

const agent = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agent.dir,
}));
const { listMcpServers, upsertMcpServer } = await import("../src/mcp/config-store");
const sdk = resolve(
	process.cwd(),
	"../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js",
);
const { loadMcpConfig } = (await import(sdk)) as {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): { errors: string[] };
};
let root: string;
let cwd: string;
let globalPath: string;
let projectPath: string;

beforeAll(() => {
	const base = resolve(process.cwd(), "../../.local/tmp");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "mcp-official-"));
	agent.dir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agent.dir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	globalPath = join(agent.dir, "mcp.json");
	projectPath = join(cwd, ".pi/mcp.json");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function compare(global: unknown, project: unknown) {
	writeFileSync(globalPath, JSON.stringify(global));
	writeFileSync(projectPath, JSON.stringify(project));
	const official = loadMcpConfig({ agentDir: agent.dir, cwd, projectTrusted: true });
	const reasons = official.errors.map((error) =>
		error.replace(globalPath, "global").replace(projectPath, "project"),
	);
	expect(validateMcpConfigs(global, project)).toEqual(reasons);
	return reasons;
}

describe("MCP 官方配置校验对照", () => {
	it("根导出与官方加载器对同一服务器给出一致原因", () => {
		for (const value of [
			{ command: "node", exposure: "model-only" },
			{ command: "node", toolExposure: { foo: "bad" } },
			{ url: "http://example.com", auth: { provider: "test" } },
			{ url: "https://example.com", oauth: { callbackUrl: "not a url", clientRegistration: "cimd" } },
			{
				url: "https://example.com",
				oauth: { callbackUrl: "http://localhost/other", clientRegistration: "cimd" },
			},
			{ command: "node", exposure: "codemode-deferred" },
			"invalid",
		]) {
			const result = validateMcpServerConfig("test", value);
			const errors = compare({ mcpServers: { test: value } }, {});
			expect(errors).toEqual(typeof result === "string" ? [`global: ${result}`] : []);
		}
	});

	it("覆盖、认证、命名冲突和顶层字段原因与加载器一致", () => {
		const cases: [unknown, unknown][] = [
			[{ autoEnableCodemode: "no", mcpServers: { a: { command: "node" } } }, { autoEnableCodemode: null }],
			[{ mcpServers: [] }, {}],
			[{}, { mcpServers: { a: { enabled: false } } }],
			[{ mcpServers: { a: { command: "node" } } }, { mcpServers: { a: { description: "extra" } } }],
			[
				{ mcpServers: { a: { command: "node" } } },
				{ mcpServers: { a: { enabled: false, exposure: "direct" } } },
			],
			[
				{ mcpServers: { a: { url: "https://example.com", auth: { provider: "test" } } } },
				{ mcpServers: { a: { enabled: false } } },
			],
			[{}, { mcpServers: { a: { url: "https://example.com", auth: { provider: "test" } } } }],
			[{ mcpServers: { "a-b": { command: "node" } } }, { mcpServers: { a_b: { command: "node" } } }],
			[{ mcpServers: { a: { command: "node" } } }, { mcpServers: { a: { command: "other" } } }],
		];
		for (const [global, project] of cases) compare(global, project);
	});

	it("手写非法配置展示官方原因，编辑失败不写盘", async () => {
		const global = {
			autoEnableCodemode: "no",
			mcpServers: { bad: { url: "https://example.com", oauth: { callbackUrl: "bad" } } },
		};
		const reasons = compare(global, {});
		const before = readFileSync(globalPath, "utf8");
		const list = await listMcpServers({ cwd, projectTrusted: true });
		for (const reason of reasons) expect(list.errors).toContain(reason);
		await expect(
			upsertMcpServer({ scope: "user", cwd, name: "new", command: "node" }, { projectTrusted: true }),
		).rejects.toThrow(reasons[0]);
		expect(readFileSync(globalPath, "utf8")).toBe(before);
	});
});
