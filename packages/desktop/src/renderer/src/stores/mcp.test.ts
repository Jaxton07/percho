import type { McpConfigListResult, McpRuntimeInventory } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	mcpConfigList: vi.fn(),
	mcpConfigUpsert: vi.fn(),
	mcpConfigImport: vi.fn(),
	mcpConfigReload: vi.fn(),
	mcpConfigRemove: vi.fn(),
}));
vi.mock("../environment-api", () => ({ getExecutionApi: () => api }));

import { getMcpStore } from "./mcp";

const server = {
	name: "my-server",
	source: "user" as const,
	transport: { kind: "unknown" as const },
	enabled: true,
	exposure: "deferred" as const,
	tools: [],
};
function inventory(revision: number, instances: McpRuntimeInventory["instances"] = []): McpRuntimeInventory {
	return { epoch: "one", revision, instances };
}
function instance(id: string, cwd = "/a", state: "connected" | "failed" = "connected") {
	return {
		instanceId: id,
		sessionId: `session-${id}`,
		cwd,
		available: true,
		errors: [] as string[],
		servers: [
			{
				name: "my-server",
				source: "/global",
				state,
				tools: [{ name: "tool" }],
				error: state === "failed" ? "failure" : undefined,
			},
		],
	};
}
function config(runtime: McpRuntimeInventory, cwd = "/a"): McpConfigListResult {
	return {
		global: [server],
		project: [],
		errors: [],
		projectTrusted: true,
		globalPath: "/global",
		contextCwd: cwd,
		runtime,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("MCP 完整运行态", () => {
	it("导入迟到时不能覆盖较新的配置", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mcp-import-order", environmentId: "e" });
		const pending = deferred<{ config: McpConfigListResult; reload: { reloaded: number; skipped: [] } }>();
		api.mcpConfigImport.mockReturnValueOnce(pending.promise);
		const importing = store.getState().importServers("{}", "/a");
		api.mcpConfigUpsert.mockResolvedValueOnce({
			config: config(inventory(2)),
			reload: { reloaded: 2, skipped: [] },
		});
		await store.getState().upsert({ scope: "user", name: "x", command: "node" });
		pending.resolve({ config: config(inventory(1)), reload: { reloaded: 1, skipped: [] } });
		await importing;
		expect(store.getState().lastReload?.reloaded).toBe(2);
	});
	it("原样提交批量导入并传播错误", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mcp-import-test", environmentId: "e" });
		api.mcpConfigImport.mockRejectedValueOnce(new Error("invalid row"));
		await expect(store.getState().importServers('{"bad":3}', "/a")).rejects.toThrow("invalid row");
		expect(api.mcpConfigImport).toHaveBeenCalledWith({ json: '{"bad":3}', cwd: "/a" });
	});
	beforeEach(() => {
		api.mcpConfigList.mockReset();
		api.mcpConfigUpsert.mockReset();
		api.mcpConfigImport.mockReset();
		api.mcpConfigRemove.mockReset();
		api.mcpConfigReload.mockReset();
	});
	it("事件先于旧基线时保留新版，并完整清除工具和错误", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mcp-test-1", environmentId: "e" });
		const pending = deferred<McpConfigListResult>();
		api.mcpConfigList.mockReturnValue(pending.promise);
		const loading = store.getState().load("/a");
		const current = instance("1", "/a", "failed");
		store.getState().applyServersChanged(
			inventory(2, [
				{
					...current,
					servers: [{ ...current.servers[0]!, state: "connected", tools: [], error: undefined }],
				},
			]),
		);
		pending.resolve(config(inventory(1, [current])));
		await loading;
		expect(store.getState().config?.global[0]).toMatchObject({
			state: "connected",
			tools: [],
			error: undefined,
		});
	});
	it("按项目选择当前会话，实例结束后不会自动切换；旧项目请求不能覆盖", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mcp-test-2", environmentId: "e" });
		const old = deferred<McpConfigListResult>();
		api.mcpConfigList
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2"), instance("3", "/b")])));
		const first = store.getState().load("/b");
		await store.getState().load("/a", "session-2");
		expect(store.getState().config?.selectedInstanceId).toBe("2");
		old.resolve(config(inventory(1), "/b"));
		await first;
		expect(store.getState().config?.contextCwd).toBe("/a");
		store.getState().applyServersChanged(inventory(2, [instance("1"), instance("3", "/b")]));
		expect(store.getState().selectedInstanceId).toBe("2");
		expect(store.getState().config?.selectedInstanceId).toBeUndefined();
		expect(store.getState().config?.global[0]?.state).toBe("unknown");
		store.getState().selectInstance("1");
		expect(store.getState().config?.selectedInstanceId).toBe("1");
	});
	it("同项目切换当前会话并拒绝迟到查询", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "switch-session", environmentId: "e" });
		const old = deferred<McpConfigListResult>();
		api.mcpConfigList
			.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])))
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
		await store.getState().load("/a", "session-1");
		const pending = store.getState().load("/a", "session-1");
		await store.getState().load("/a", "session-2");
		old.resolve(config(inventory(1, [instance("1"), instance("2")])));
		await pending;
		expect(store.getState().config?.selectedInstanceId).toBe("2");
	});
	it("主动重连跟随同会话新实例，普通关闭不切换", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "reconnect", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
		await store.getState().load("/a", "session-1");
		api.mcpConfigReload.mockResolvedValueOnce({
			config: config(inventory(2, [{ ...instance("new"), sessionId: "session-1" }, instance("2")])),
			reload: { reloaded: 1, skipped: [] },
		});
		await store.getState().reload("/a");
		expect(store.getState().selectedInstanceId).toBe("new");
		store.getState().applyServersChanged(inventory(3, [instance("2")]));
		expect(store.getState().selectedInstanceId).toBe("new");
	});
	it.each(["upsert", "import", "remove", "reload"] as const)(
		"%s 失败后重读已落盘的较早操作",
		async (kind) => {
			const store = getMcpStore({ kind: "ssh", connectionId: `recover-${kind}`, environmentId: "e" });
			api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
			await store.getState().load("/a", "session-1");
			const first = deferred<{ config: McpConfigListResult; reload: { reloaded: number; skipped: [] } }>();
			const failed = deferred<never>();
			const recovery = deferred<McpConfigListResult>();
			api.mcpConfigUpsert.mockReturnValueOnce(first.promise);
			const pending = store.getState().upsert({ scope: "user", name: "one" });
			const calls = {
				upsert: () => store.getState().upsert({ scope: "user", name: "two" }),
				import: () => store.getState().importServers("{}", "/a"),
				remove: () => store.getState().remove({ scope: "user", name: "two" }),
				reload: () => store.getState().reload("/a"),
			};
			const mocks = {
				upsert: api.mcpConfigUpsert,
				import: api.mcpConfigImport,
				remove: api.mcpConfigRemove,
				reload: api.mcpConfigReload,
			};
			mocks[kind].mockReturnValueOnce(failed.promise);
			api.mcpConfigList.mockReturnValueOnce(recovery.promise);
			const second = calls[kind]();
			const error = new Error("mutation failed");
			const rejected = expect(second).rejects.toBe(error);
			failed.reject(error);
			await Promise.resolve();
			expect(api.mcpConfigList).toHaveBeenLastCalledWith({ cwd: "/a" });
			recovery.resolve({
				...config(inventory(2, [{ ...instance("new"), sessionId: "session-1" }])),
				globalPath: "/saved",
			});
			await rejected;
			expect(store.getState().config?.globalPath).toBe("/saved");
			expect(store.getState().selectedInstanceId).toBe("new");
			api.mcpConfigList.mockResolvedValueOnce({
				...config(inventory(2, [{ ...instance("new"), sessionId: "session-1" }])),
				globalPath: "/saved",
			});
			first.resolve({
				config: { ...config(inventory(1)), globalPath: "/stale" },
				reload: { reloaded: 0, skipped: [] },
			});
			await pending;
			expect(store.getState().config?.globalPath).toBe("/saved");
		},
	);
	it("较晚请求在较早写入落盘前失败，较早完成后再次对账", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "reconcile-late-write", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const earlier = deferred<{ config: McpConfigListResult; reload: { reloaded: number; skipped: [] } }>();
		api.mcpConfigUpsert.mockReturnValueOnce(earlier.promise);
		const pending = store.getState().upsert({ scope: "user", name: "one" });
		api.mcpConfigRemove.mockRejectedValueOnce(new Error("invalid later operation"));
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await expect(store.getState().remove({ scope: "user", name: "invalid" })).rejects.toThrow(
			"invalid later operation",
		);
		const saved = { ...config(inventory(2)), globalPath: "/actually-saved" };
		api.mcpConfigList.mockResolvedValueOnce(saved);
		earlier.resolve({ config: saved, reload: { reloaded: 0, skipped: [] } });
		await pending;
		expect(api.mcpConfigList).toHaveBeenCalledTimes(3);
		expect(store.getState().config?.globalPath).toBe("/actually-saved");
	});
	it("切换上下文后失败不重读旧目录，在途恢复不能覆盖新查询", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "recover-context", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const failed = deferred<never>();
		api.mcpConfigRemove.mockReturnValueOnce(failed.promise);
		const pending = store.getState().remove({ scope: "user", name: "x" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(2), "/b"));
		await store.getState().load("/b");
		failed.reject(new Error("failed"));
		await expect(pending).rejects.toThrow("failed");
		expect(api.mcpConfigList).toHaveBeenCalledTimes(2);
		expect(store.getState().config?.contextCwd).toBe("/b");
		const recovery = deferred<McpConfigListResult>();
		api.mcpConfigList.mockReturnValueOnce(recovery.promise);
		api.mcpConfigRemove.mockRejectedValueOnce(new Error("again"));
		const second = store.getState().remove({ scope: "user", name: "x" });
		const rejected = expect(second).rejects.toThrow("again");
		await Promise.resolve();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(3), "/c"));
		await store.getState().load("/c");
		recovery.resolve(config(inventory(2), "/b"));
		await rejected;
		expect(store.getState().config?.contextCwd).toBe("/c");
	});
	it("恢复读取失败保留原错误，恢复在途时较新操作拥有提交权", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "recover-order", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
		await store.getState().load("/a", "session-1");
		const error = new Error("original");
		api.mcpConfigRemove.mockRejectedValueOnce(error);
		api.mcpConfigList.mockRejectedValueOnce(new Error("read failed"));
		await expect(store.getState().remove({ scope: "user", name: "x" })).rejects.toBe(error);
		const recovery = deferred<McpConfigListResult>();
		api.mcpConfigRemove.mockRejectedValueOnce(error);
		api.mcpConfigList.mockReturnValueOnce(recovery.promise);
		const rejected = expect(store.getState().remove({ scope: "user", name: "x" })).rejects.toBe(error);
		await Promise.resolve();
		store.getState().selectInstance("2");
		api.mcpConfigReload.mockResolvedValueOnce({
			config: { ...config(inventory(3, [instance("2")])), globalPath: "/new" },
			reload: { reloaded: 0, skipped: [] },
		});
		await store.getState().reload("/a");
		recovery.resolve({ ...config(inventory(2)), globalPath: "/old" });
		await rejected;
		expect(store.getState().config?.globalPath).toBe("/new");
		expect(store.getState().selectedInstanceId).toBe("2");
	});
	it("较早写操作迟到不能覆盖较新配置", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mutation-order", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const old = deferred<{ config: McpConfigListResult; reload: { reloaded: number; skipped: [] } }>();
		api.mcpConfigUpsert.mockReturnValueOnce(old.promise).mockResolvedValueOnce({
			config: { ...config(inventory(3)), globalPath: "/new" },
			reload: { reloaded: 0, skipped: [] },
		});
		const first = store.getState().upsert({ scope: "user", name: "one" });
		await store.getState().upsert({ scope: "user", name: "two" });
		old.resolve({
			config: { ...config(inventory(2)), globalPath: "/old" },
			reload: { reloaded: 0, skipped: [] },
		});
		await first;
		expect(store.getState().config?.globalPath).toBe("/new");
	});
	it("重连找不到同会话时保留已结束选择，用户中途选择不被覆盖", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "reconnect-selection", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
		await store.getState().load("/a", "session-1");
		api.mcpConfigReload.mockResolvedValueOnce({
			config: config(inventory(2, [instance("2")])),
			reload: { reloaded: 0, skipped: [] },
		});
		await store.getState().reload("/a");
		expect(store.getState().selectedInstanceId).toBe("1");
		const pending = deferred<{ config: McpConfigListResult; reload: { reloaded: number; skipped: [] } }>();
		api.mcpConfigReload.mockReturnValueOnce(pending.promise);
		const loading = store.getState().reload("/a");
		store.getState().selectInstance("2");
		pending.resolve({
			config: config(inventory(3, [{ ...instance("new"), sessionId: "session-1" }, instance("2")])),
			reload: { reloaded: 1, skipped: [] },
		});
		await loading;
		expect(store.getState().selectedInstanceId).toBe("2");
	});
	it("不同环境配置与选择独立", async () => {
		const a = getMcpStore({ kind: "ssh", connectionId: "isolation", environmentId: "a" });
		const b = getMcpStore({ kind: "ssh", connectionId: "isolation", environmentId: "b" });
		api.mcpConfigList
			.mockResolvedValueOnce(config(inventory(1, [instance("a")])))
			.mockResolvedValueOnce(config(inventory(1, [instance("b")])));
		await a.getState().load("/a");
		await b.getState().load("/a");
		b.getState().applyServersChanged(inventory(2, []));
		expect(a.getState().config?.selectedInstanceId).toBe("a");
		expect(b.getState().selectedInstanceId).toBe("b");
		expect(b.getState().config?.selectedInstanceId).toBeUndefined();
	});
	it("已替换的旧 epoch 不能通过后续基线或事件复活", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "retired-epoch", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("old")])));
		await store.getState().load("/a");
		store.getState().applyServersChanged({ epoch: "new", revision: 1, instances: [instance("new")] });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(99, [instance("old")])));
		await store.getState().load("/a");
		store.getState().applyServersChanged(inventory(100, [instance("old")]));
		expect(store.getState().config?.runtime?.epoch).toBe("new");
	});
	it("后来的新代次事件不被旧请求覆盖", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mcp-test-3", environmentId: "e" });
		const pending = deferred<McpConfigListResult>();
		api.mcpConfigList.mockReturnValue(pending.promise);
		const loading = store.getState().load("/a");
		store.getState().applyServersChanged({ epoch: "new", revision: 1, instances: [instance("new")] });
		pending.resolve(config(inventory(99, [instance("old")])));
		await loading;
		expect(store.getState().config?.selectedInstanceId).toBe("new");
	});
});
