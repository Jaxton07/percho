import type { McpConfigListResult, McpRuntimeInventory } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	mcpConfigList: vi.fn(),
	mcpConfigUpsert: vi.fn(),
	mcpConfigImport: vi.fn(),
	mcpReconnect: vi.fn(),
	mcpConfigRemove: vi.fn(),
}));
vi.mock("../environment-api", () => ({ getExecutionApi: () => api }));

import { getMcpStore, mcpActionKey } from "./mcp";

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
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(0)));
		await store.getState().load("/a");
		const pending = deferred<{ config: McpConfigListResult }>();
		api.mcpConfigImport.mockReturnValueOnce(pending.promise);
		const importing = store.getState().importServers("{}", "/a");
		api.mcpConfigUpsert.mockResolvedValueOnce({
			config: config(inventory(2)),
		});
		await store.getState().upsert({ scope: "user", name: "x", command: "node" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(2)));
		pending.resolve({ config: config(inventory(1)) });
		await importing;
		expect(store.getState().config?.runtime?.revision).toBe(2);
	});
	it("原样提交批量导入并传播错误", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mcp-import-test", environmentId: "e" });
		api.mcpConfigImport.mockRejectedValueOnce(new Error("invalid row"));
		await expect(store.getState().importServers('{"bad":3}', "/a")).rejects.toThrow("invalid row");
		expect(store.getState().restartRequired).toBe(false);
		expect(api.mcpConfigImport).toHaveBeenCalledWith({ json: '{"bad":3}', cwd: "/a" });
	});
	beforeEach(() => {
		api.mcpConfigList.mockReset();
		api.mcpConfigUpsert.mockReset();
		api.mcpConfigImport.mockReset();
		api.mcpConfigRemove.mockReset();
		api.mcpReconnect.mockReset();
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
	it("保存不切换选中实例，重连不清除重启标志", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "reconnect", environmentId: "e" });
		const saved = { ...config(inventory(1, [instance("1"), instance("2")])), restartRequired: true };
		api.mcpConfigList.mockResolvedValueOnce(saved);
		await store.getState().load("/a", "session-1");
		api.mcpConfigUpsert.mockResolvedValueOnce({ config: saved });
		await store.getState().upsert({ scope: "user", name: "my-server" });
		await store.getState().reconnect("my-server");
		expect(api.mcpReconnect).toHaveBeenCalledWith({ instanceId: "1", name: "my-server" });
		expect(store.getState().selectedInstanceId).toBe("1");
		store.getState().applyServersChanged(inventory(2, [instance("1"), instance("2")]));
		expect(store.getState().restartRequired).toBe(true);
	});
	it.each(["upsert", "import", "remove"] as const)(
		"%s 失败后重读已落盘的较早操作并保留当前选择，同时在较早写入迟到时再次执行权威对账",
		async (kind) => {
			const store = getMcpStore({ kind: "ssh", connectionId: `recover-${kind}`, environmentId: "e" });
			api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
			await store.getState().load("/a", "session-1");
			const first = deferred<{ config: McpConfigListResult }>();
			const failed = deferred<never>();
			const recovery = deferred<McpConfigListResult>();
			api.mcpConfigUpsert.mockReturnValueOnce(first.promise);
			const pending = store.getState().upsert({ scope: "user", name: "one" });
			const calls = {
				upsert: () => store.getState().upsert({ scope: "user", name: "two" }),
				import: () => store.getState().importServers("{}", "/a"),
				remove: () => store.getState().remove({ scope: "user", name: "two" }),
			};
			const mocks = {
				upsert: api.mcpConfigUpsert,
				import: api.mcpConfigImport,
				remove: api.mcpConfigRemove,
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
			expect(store.getState().selectedInstanceId).toBe("1");
			api.mcpConfigList.mockResolvedValueOnce({
				...config(inventory(2, [{ ...instance("new"), sessionId: "session-1" }])),
				globalPath: "/saved",
			});
			first.resolve({
				config: { ...config(inventory(1)), globalPath: "/stale" },
			});
			await pending;
			expect(store.getState().config?.globalPath).toBe("/saved");
		},
	);
	it("较晚请求在较早写入落盘前失败，较早完成后再次对账", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "reconcile-late-write", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const earlier = deferred<{ config: McpConfigListResult }>();
		api.mcpConfigUpsert.mockReturnValueOnce(earlier.promise);
		const pending = store.getState().upsert({ scope: "user", name: "one" });
		api.mcpConfigRemove.mockRejectedValueOnce(new Error("invalid later operation"));
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await expect(store.getState().remove({ scope: "user", name: "invalid" })).rejects.toThrow(
			"invalid later operation",
		);
		const saved = { ...config(inventory(2)), globalPath: "/actually-saved" };
		api.mcpConfigList.mockResolvedValueOnce(saved);
		earlier.resolve({ config: saved });
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
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(2), "/b"));
		failed.reject(new Error("failed"));
		await expect(pending).rejects.toThrow("failed");
		expect(api.mcpConfigList).toHaveBeenCalledTimes(3);
		expect(api.mcpConfigList).toHaveBeenLastCalledWith({ cwd: "/b" });
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
		api.mcpConfigUpsert.mockResolvedValueOnce({
			config: { ...config(inventory(3, [instance("2")])), globalPath: "/new" },
		});
		await store.getState().upsert({ scope: "user", name: "x" });
		recovery.resolve({ ...config(inventory(2)), globalPath: "/old" });
		await rejected;
		expect(store.getState().config?.globalPath).toBe("/new");
		expect(store.getState().selectedInstanceId).toBe("2");
	});
	it.each(["read-first", "write-first"] as const)(
		"写入与同上下文重读交错，保存结果不被旧读取遮蔽（%s）",
		async (order) => {
			const store = getMcpStore({ kind: "ssh", connectionId: `load-write-${order}`, environmentId: "e" });
			api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
			await store.getState().load("/a");
			const write = deferred<{ config: McpConfigListResult }>();
			const read = deferred<McpConfigListResult>();
			api.mcpConfigUpsert.mockReturnValueOnce(write.promise);
			const saving = store.getState().upsert({ scope: "user", name: "saved" });
			api.mcpConfigList.mockReturnValueOnce(read.promise);
			const loading = store.getState().load("/a");
			const saved = { ...config(inventory(2)), globalPath: "/saved" };
			if (order === "read-first") {
				read.resolve(config(inventory(1)));
				await loading;
				write.resolve({ config: saved });
				await saving;
			} else {
				write.resolve({ config: saved });
				await saving;
				read.resolve(config(inventory(1)));
				await loading;
			}
			expect(store.getState().config?.globalPath).toBe("/saved");
			expect(store.getState().loading).toBe(false);
			expect(store.getState().config?.runtime?.revision).toBe(2);
		},
	);
	it("写入失败后的权威对账也能撤销较早的读取", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "failed-write-old-read", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const write = deferred<never>();
		const oldRead = deferred<McpConfigListResult>();
		api.mcpConfigUpsert.mockReturnValueOnce(write.promise);
		const rejected = expect(store.getState().upsert({ scope: "user", name: "failed" })).rejects.toThrow(
			"failed",
		);
		api.mcpConfigList.mockReturnValueOnce(oldRead.promise);
		const loading = store.getState().load("/a");
		api.mcpConfigList.mockResolvedValueOnce({ ...config(inventory(2)), globalPath: "/reconciled" });
		write.reject(new Error("failed"));
		await rejected;
		oldRead.resolve(config(inventory(1)));
		await loading;
		expect(store.getState().config?.globalPath).toBe("/reconciled");
		expect(store.getState().loading).toBe(false);
	});
	it("失败对账不能覆盖在它之后发起的刷新", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "recovery-versus-refresh", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const recovery = deferred<McpConfigListResult>();
		const started = deferred<void>();
		api.mcpConfigUpsert.mockRejectedValueOnce(new Error("failed"));
		api.mcpConfigList.mockImplementationOnce(() => {
			started.resolve(undefined);
			return recovery.promise;
		});
		const rejected = expect(store.getState().upsert({ scope: "user", name: "failed" })).rejects.toThrow(
			"failed",
		);
		await started.promise;
		api.mcpConfigList.mockResolvedValueOnce({ ...config(inventory(3)), globalPath: "/manual-refresh" });
		await store.getState().load("/a");
		recovery.resolve({ ...config(inventory(2)), globalPath: "/older-recovery" });
		await rejected;
		expect(store.getState().config?.globalPath).toBe("/manual-refresh");
		expect(store.getState().loading).toBe(false);
	});
	it("对账与被撤销的刷新都失败时仍结束加载", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "recovery-failed-loading", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const oldRead = deferred<McpConfigListResult>();
		api.mcpConfigList.mockReturnValueOnce(oldRead.promise);
		const refreshing = store.getState().load("/a");
		api.mcpConfigUpsert.mockRejectedValueOnce(new Error("write failed"));
		api.mcpConfigList.mockRejectedValueOnce(new Error("recovery read failed"));
		await expect(store.getState().upsert({ scope: "user", name: "failed" })).rejects.toThrow("write failed");
		oldRead.resolve(config(inventory(1)));
		await refreshing;
		expect(store.getState().loading).toBe(false);
		expect(store.getState().config?.contextCwd).toBe("/a");
	});
	it("切换项目后旧全局写入完成，只重读当前项目权威配置", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "late-write-new-context", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const write = deferred<{ config: McpConfigListResult }>();
		api.mcpConfigUpsert.mockReturnValueOnce(write.promise);
		const saving = store.getState().upsert({ scope: "user", name: "saved" });
		api.mcpConfigList.mockResolvedValueOnce({ ...config(inventory(2), "/b"), globalPath: "/before" });
		await store.getState().load("/b");
		api.mcpConfigList.mockResolvedValueOnce({ ...config(inventory(3), "/b"), globalPath: "/after" });
		write.resolve({
			config: { ...config(inventory(2)), globalPath: "/old-context" },
		});
		await saving;
		expect(api.mcpConfigList).toHaveBeenLastCalledWith({ cwd: "/b" });
		expect(store.getState().config?.contextCwd).toBe("/b");
		expect(store.getState().config?.globalPath).toBe("/after");
	});
	it.each([false, true])("实时启用值消失后恢复配置值（configured=%s）", async (configured) => {
		const store = getMcpStore({
			kind: "ssh",
			connectionId: `configured-enabled-${configured}`,
			environmentId: "e",
		});
		const base = config(inventory(1, []));
		base.global = base.global.map((server) => ({ ...server, enabled: configured }));
		api.mcpConfigList.mockResolvedValueOnce(base);
		await store.getState().load("/a");
		const live = {
			...instance("one"),
			servers: instance("one").servers.map((server) => ({
				...server,
				state: configured ? ("disabled" as const) : ("connected" as const),
			})),
		};
		store.getState().applyServersChanged(inventory(2, [live]));
		expect(store.getState().config?.global[0]?.enabled).toBe(!configured);
		store.getState().applyServersChanged(inventory(3, []));
		expect(store.getState().config?.global[0]?.enabled).toBe(configured);
		expect(store.getState().config?.global[0]?.state).toBe(configured ? "not-started" : "disabled");
	});
	it("较早写操作迟到不能覆盖较新配置", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "mutation-order", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const old = deferred<{ config: McpConfigListResult }>();
		api.mcpConfigUpsert.mockReturnValueOnce(old.promise).mockResolvedValueOnce({
			config: { ...config(inventory(3)), globalPath: "/new" },
		});
		const first = store.getState().upsert({ scope: "user", name: "one" });
		await store.getState().upsert({ scope: "user", name: "two" });
		api.mcpConfigList.mockResolvedValueOnce({ ...config(inventory(3)), globalPath: "/new" });
		old.resolve({
			config: { ...config(inventory(2)), globalPath: "/old" },
		});
		await first;
		expect(store.getState().config?.globalPath).toBe("/new");
	});
	it("保存途中用户选择不被覆盖，失效实例不重连", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "reconnect-selection", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
		await store.getState().load("/a", "session-1");
		const pending = deferred<{ config: McpConfigListResult }>();
		api.mcpConfigUpsert.mockReturnValueOnce(pending.promise);
		const saving = store.getState().upsert({ scope: "user", name: "x" });
		store.getState().selectInstance("2");
		pending.resolve({ config: config(inventory(2, [instance("1"), instance("2")])) });
		await saving;
		expect(store.getState().selectedInstanceId).toBe("2");
		store.getState().applyServersChanged(inventory(3, [instance("1")]));
		await expect(store.getState().reconnect("my-server")).rejects.toThrow();
		expect(api.mcpReconnect).not.toHaveBeenCalled();
	});
	it("同目标单飞，撤销实例或切换 epoch 后迟到失败不能复活", async () => {
		for (const change of ["remove", "epoch"] as const) {
			const store = getMcpStore({ kind: "ssh", connectionId: `action-${change}`, environmentId: "e" });
			api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
			await store.getState().load("/a", "session-1");
			const pending = deferred<void>();
			api.mcpReconnect.mockReturnValueOnce(pending.promise);
			const first = store.getState().reconnect("my-server");
			store.getState().applyServersChanged(
				inventory(2, [
					{
						...instance("1"),
						servers: instance("1").servers.map((item) => ({ ...item, state: "connecting" as const })),
					},
					instance("2"),
				]),
			);
			const second = store.getState().reconnect("my-server");
			expect(first).toBe(second);
			await Promise.resolve();
			expect(api.mcpReconnect).toHaveBeenCalledTimes(1);
			expect(store.getState().reconnectActions[mcpActionKey("1", "my-server")]?.pending).toBe(true);
			store
				.getState()
				.applyServersChanged(
					change === "remove"
						? inventory(3, [instance("2")])
						: { epoch: "next", revision: 1, instances: [instance("1")] },
				);
			const rejected = expect(first).rejects.toThrow("late");
			pending.reject(new Error("late"));
			await rejected;
			expect(store.getState().reconnectActions).toEqual({});
			api.mcpReconnect.mockReset();
		}
	});
	it("不同实例、服务器和环境各自独立运行", async () => {
		const a = getMcpStore({ kind: "ssh", connectionId: "action-isolation", environmentId: "a" });
		const b = getMcpStore({ kind: "ssh", connectionId: "action-isolation", environmentId: "b" });
		const live = instance("1");
		const withOther = { ...live, servers: [...live.servers, { ...live.servers[0]!, name: "other" }] };
		api.mcpConfigList.mockResolvedValue(config(inventory(1, [withOther, instance("2")])));
		await a.getState().load("/a", "session-1");
		await b.getState().load("/a", "session-1");
		const pending = deferred<void>();
		api.mcpReconnect.mockReturnValue(pending.promise);
		const requests = [
			a.getState().reconnect("my-server"),
			a.getState().reconnect("other"),
			b.getState().reconnect("my-server"),
		];
		a.getState().selectInstance("2");
		requests.push(a.getState().reconnect("my-server"));
		await Promise.resolve();
		expect(api.mcpReconnect).toHaveBeenCalledTimes(4);
		expect(Object.keys(a.getState().reconnectActions)).toHaveLength(3);
		expect(Object.keys(b.getState().reconnectActions)).toHaveLength(1);
		pending.resolve(undefined);
		await Promise.all(requests);
		expect(a.getState().reconnectActions).toEqual({});
		expect(b.getState().reconnectActions).toEqual({});
	});
	it("同步异常可见且可重试，不支持的状态拒绝重连", async () => {
		const store = getMcpStore({ kind: "ssh", connectionId: "action-sync", environmentId: "e" });
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
		await store.getState().load("/a");
		api.mcpReconnect
			.mockImplementationOnce(() => {
				throw new Error("sync failure");
			})
			.mockResolvedValueOnce(undefined);
		await expect(store.getState().reconnect("my-server")).rejects.toThrow("sync failure");
		expect(store.getState().reconnectActions[mcpActionKey("1", "my-server")]?.error).toBe("sync failure");
		await store.getState().reconnect("my-server");
		expect(store.getState().reconnectActions).toEqual({});
		for (const state of ["connecting", "closed", "unknown"] as const) {
			const live = instance("1");
			store
				.getState()
				.applyServersChanged(
					inventory(store.getState().config!.runtime!.revision + 1, [
						{ ...live, servers: [{ ...live.servers[0]!, state }] },
					]),
				);
			await expect(store.getState().reconnect("my-server")).rejects.toThrow();
		}
		expect(api.mcpReconnect).toHaveBeenCalledTimes(2);
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
