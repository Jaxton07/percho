import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateMcpServerConfig } from "@earendil-works/pi-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ value: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, getAgentDir: () => agentDir.value };
});

const { listMcpServers, removeMcpServer, upsertMcpServer } = await import("../src/mcp/config-store");

let root = "";
let cwd = "";

beforeEach(() => {
	const base = join(process.cwd(), "../../.local/tmp");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "percho-mcp-config-"));
	agentDir.value = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir.value, { recursive: true });
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function readGlobal(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(agentDir.value, "mcp.json"), "utf8")) as Record<string, unknown>;
}

describe("mcp.json 读写（spec §4.8）", () => {
	it("按 SDK 校验名称并保留合法名称", async () => {
		for (const name of ["my-server", "double__underscore", "a".repeat(200)]) {
			await upsertMcpServer({ scope: "user", name, command: "node" }, { projectTrusted: false });
		}
		const before = readFileSync(join(agentDir.value, "mcp.json"), "utf8");
		for (const name of ["a.b", "a b", "中文"]) {
			await expect(
				upsertMcpServer({ scope: "user", name, command: "node" }, { projectTrusted: false }),
			).rejects.toThrow(/invalid server name/i);
		}
		expect(readFileSync(join(agentDir.value, "mcp.json"), "utf8")).toBe(before);
	});

	it("诊断现有非法配置及跨受信项目命名空间冲突，同名覆盖合法", async () => {
		writeFileSync(
			join(agentDir.value, "mcp.json"),
			JSON.stringify({
				other: 42,
				mcpServers: { "my-server": { command: "node" }, "bad.name": { command: "node" } },
			}),
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { my_server: { command: "node" } } }),
		);
		const result = await listMcpServers({ cwd, projectTrusted: true });
		expect(result.global.map((s) => s.name)).toContain("bad.name");
		expect(result.errors.join(" ")).toMatch(/bad.name/);
		expect(result.errors.join(" ")).toMatch(/my-server.*my_server|my_server.*my-server/);
		const before = readFileSync(join(agentDir.value, "mcp.json"), "utf8");
		await expect(
			upsertMcpServer({ scope: "user", cwd, name: "new", command: "node" }, { projectTrusted: true }),
		).rejects.toThrow();
		expect(readFileSync(join(agentDir.value, "mcp.json"), "utf8")).toBe(before);
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { "my-server": { command: "other" } } }),
		);
		const override = await listMcpServers({ cwd, projectTrusted: true });
		expect(override.errors.join(" ")).not.toMatch(/my-server/);
	});

	it("同真实 SDK 对照名称、传输及受信项目覆盖", async () => {
		for (const [name, config] of [
			["my-server", { command: "node" }],
			["x__y", { command: "node" }],
			["a".repeat(200), { command: "node" }],
			["bad.name", { command: "node" }],
			["bad", { url: "invalid" }],
		] as const) {
			const expected = validateMcpServerConfig(name, config).kind !== "invalid";
			writeFileSync(join(agentDir.value, "mcp.json"), JSON.stringify({ mcpServers: { [name]: config } }));
			const result = await listMcpServers({ projectTrusted: false });
			expect(result.errors.length === 0).toBe(expected);
		}
		writeFileSync(
			join(agentDir.value, "mcp.json"),
			JSON.stringify({ mcpServers: { "my-server": { command: "node" } } }),
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { "my-server": { enabled: false } } }),
		);
		expect((await listMcpServers({ cwd, projectTrusted: true })).errors).toEqual([]);
		const before = readFileSync(join(agentDir.value, "mcp.json"), "utf8");
		await expect(
			upsertMcpServer({ scope: "user", cwd, name: "my_server", command: "node" }, { projectTrusted: true }),
		).rejects.toThrow(/my-server/);
		expect(readFileSync(join(agentDir.value, "mcp.json"), "utf8")).toBe(before);
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { my_server: { command: "node" } } }),
		);
		await upsertMcpServer({ scope: "user", cwd, name: "other", command: "node" }, { projectTrusted: false });
	});

	it("拒绝 SDK 不支持的传输并保留文件", async () => {
		await upsertMcpServer({ scope: "user", name: "ok", command: "node" }, { projectTrusted: false });
		const before = readFileSync(join(agentDir.value, "mcp.json"), "utf8");
		await expect(
			upsertMcpServer({ scope: "user", name: "bad", url: "not-a-url" }, { projectTrusted: false }),
		).rejects.toThrow(/url/i);
		expect(readFileSync(join(agentDir.value, "mcp.json"), "utf8")).toBe(before);
	});
	it("新建文件时写顶层 autoEnableCodemode: false，server 缺省 exposure 写 deferred", async () => {
		await upsertMcpServer(
			{ scope: "user", name: "demo", command: "node", args: ["server.mjs"], description: "本地 demo" },
			{ projectTrusted: false },
		);

		const file = readGlobal();
		expect(file.autoEnableCodemode).toBe(false);
		expect(file.mcpServers).toEqual({
			demo: { command: "node", args: ["server.mjs"], description: "本地 demo", exposure: "deferred" },
		});
	});

	it("编辑既有 server 不改 exposure（不传就保持原值）", async () => {
		await upsertMcpServer(
			{ scope: "user", name: "demo", command: "node", exposure: "direct" },
			{ projectTrusted: false },
		);
		await upsertMcpServer({ scope: "user", name: "demo", description: "改说明" }, { projectTrusted: false });

		const servers = (readGlobal().mcpServers as Record<string, Record<string, unknown>>).demo;
		expect(servers.exposure).toBe("direct");
		expect(servers.description).toBe("改说明");
		expect(servers.command).toBe("node");
	});

	it("command 与 url 互斥；换传输方式时清掉另一种字段", async () => {
		await expect(
			upsertMcpServer(
				{ scope: "user", name: "x", command: "node", url: "https://a" },
				{ projectTrusted: false },
			),
		).rejects.toThrow("只能填一个");

		await upsertMcpServer({ scope: "user", name: "x", command: "node" }, { projectTrusted: false });
		await upsertMcpServer(
			{ scope: "user", name: "x", url: "https://a.example/mcp" },
			{ projectTrusted: false },
		);
		const entry = (readGlobal().mcpServers as Record<string, Record<string, unknown>>).x;
		expect(entry.url).toBe("https://a.example/mcp");
		expect(entry.command).toBeUndefined();
	});

	it("list 给出有效 exposure（缺省 = 官方默认 codemode）与逐工具覆盖", async () => {
		writeFileSync(
			join(agentDir.value, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					legacy: { command: "node" }, // 无 exposure → 有效值 codemode
					modern: {
						url: "https://a.example/mcp",
						exposure: "deferred",
						toolExposure: { search: "direct" },
						enabled: false,
					},
				},
			}),
		);

		const result = await listMcpServers({ projectTrusted: false });

		const legacy = result.global.find((s) => s.name === "legacy");
		expect(legacy?.exposure).toBe("codemode");
		expect(legacy?.exposureRaw).toBeUndefined();
		expect(legacy?.enabled).toBe(true);
		const modern = result.global.find((s) => s.name === "modern");
		expect(modern).toMatchObject({ exposure: "deferred", exposureRaw: "deferred", enabled: false });
		expect(modern?.toolExposure).toEqual({ search: "direct" });
		expect(modern?.transport).toEqual({ kind: "url", url: "https://a.example/mcp" });
	});

	it("配置读取不推断运行态工具", async () => {
		writeFileSync(
			join(agentDir.value, "mcp.json"),
			JSON.stringify({ mcpServers: { demo: { command: "node" } } }),
		);

		const result = await listMcpServers({ projectTrusted: false });

		expect(result.global[0]?.tools).toEqual([]);
	});

	it("项目级配置只在受信项目读；写入项目级在未受信时被拒", async () => {
		writeFileSync(
			join(agentDir.value, "mcp.json"),
			JSON.stringify({ mcpServers: { globalOnly: { command: "node" } } }),
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { projectOnly: { command: "node" } } }),
		);

		const untrusted = await listMcpServers({ cwd, projectTrusted: false });
		expect(untrusted.project).toEqual([]);
		expect(untrusted.projectPath).toBeUndefined();

		const trusted = await listMcpServers({ cwd, projectTrusted: true });
		expect(trusted.project.map((s) => s.name)).toEqual(["projectOnly"]);
		expect(trusted.projectPath).toBe(join(cwd, ".pi", "mcp.json"));

		await expect(
			upsertMcpServer({ scope: "project", cwd, name: "x", command: "node" }, { projectTrusted: false }),
		).rejects.toThrow("项目未受信");
	});

	it("形状错误进 errors 而不抛（面板红字展示）", async () => {
		writeFileSync(join(agentDir.value, "mcp.json"), JSON.stringify({ mcpServers: { bad: "not-an-object" } }));

		const result = await listMcpServers({ projectTrusted: false });

		expect(result.global).toMatchObject([{ name: "bad", transport: { kind: "unknown" } }]);
		expect(result.errors[0]).toContain("bad");
	});

	it("remove 按 name 删除（全局）", async () => {
		await upsertMcpServer({ scope: "user", name: "a", command: "node" }, { projectTrusted: false });
		await upsertMcpServer({ scope: "user", name: "b", command: "node" }, { projectTrusted: false });

		await removeMcpServer({ scope: "user", name: "a" });

		expect(Object.keys(readGlobal().mcpServers as Record<string, unknown>)).toEqual(["b"]);
	});

	it("server 名非法被拒（它是工具名前缀，必须安全）", async () => {
		await expect(
			upsertMcpServer({ scope: "user", name: "a b/c", command: "node" }, { projectTrusted: false }),
		).rejects.toThrow(/invalid server name/i);
	});
});
