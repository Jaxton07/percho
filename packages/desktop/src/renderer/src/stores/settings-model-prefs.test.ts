import { type ModelPrefs, withModelHidden, withModelsHidden, withProviderModelsHidden } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getModelPrefs: vi.fn(),
	setModelHidden: vi.fn(),
	setModelsHidden: vi.fn(),
	setProviderModelsHidden: vi.fn(),
	setSubagentModel: vi.fn(),
	setSubagentThinking: vi.fn(),
	setSubagentPreferBuiltin: vi.fn(),
	listProviders: vi.fn(),
	listSubagents: vi.fn(),
	getPermissionConfig: vi.fn(),
	getContextManagerConfig: vi.fn(),
	getChannelWatchConfig: vi.fn(),
	lanGetStatus: vi.fn(),
	loadModels: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => api }));
vi.mock("./sessions", () => ({
	useSessionsStore: { getState: () => ({ loadModels: api.loadModels, activeSessionId: null }) },
}));

const empty = (): ModelPrefs => ({ hiddenModels: {}, subagentModels: {} });
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
let store: typeof import("./settings").useSettingsStore;

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	api.getModelPrefs.mockImplementation(async () => empty());
	api.listProviders.mockResolvedValue([]);
	api.listSubagents.mockResolvedValue([]);
	api.getPermissionConfig.mockResolvedValue({ enabled: true });
	api.getContextManagerConfig.mockResolvedValue({ mode: "evaporation" });
	api.getChannelWatchConfig.mockResolvedValue({ enabled: true });
	api.lanGetStatus.mockResolvedValue(null);
	api.loadModels.mockResolvedValue(undefined);
	store = (await import("./settings")).useSettingsStore;
	store.setState({ modelPrefs: empty() });
});

describe("settings modelPrefs serial optimistic projection", () => {
	it("同步 store 订阅中追加的操作仍排在触发它的原始操作之后", async () => {
		let disk = empty();
		const order: string[] = [];
		api.setProviderModelsHidden.mockImplementation(async ({ provider, hidden }) => {
			order.push("provider");
			disk = withProviderModelsHidden(disk, provider, hidden);
			return disk;
		});
		api.setModelHidden.mockImplementation(async ({ provider, modelId, hidden }) => {
			order.push("model");
			disk = withModelHidden(disk, provider, modelId, hidden);
			return disk;
		});
		let second: Promise<void> | undefined;
		let unsubscribe = () => {};
		unsubscribe = store.subscribe((state) => {
			if (!state.modelPrefs?.hiddenProviders?.includes("p")) return;
			unsubscribe();
			second = state.setModelHidden("p", "a", false);
		});
		try {
			await store.getState().setProviderModelsHidden("p", true);
			expect(second).toBeDefined();
			await second;
			expect(order).toEqual(["provider", "model"]);
			expect(store.getState().modelPrefs?.visibleModels).toEqual({ p: ["a"] });
		} finally {
			unsubscribe();
		}
	});

	it("整源不枚举 IDs：立即投影并采用权威返回（含其他偏好域）", async () => {
		const response = deferred<ModelPrefs>();
		api.setProviderModelsHidden.mockReturnValue(response.promise);
		const done = store.getState().setProviderModelsHidden("p", true);
		expect(store.getState().modelPrefs?.hiddenProviders).toEqual(["p"]);
		expect(api.setModelsHidden).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(api.setProviderModelsHidden).toHaveBeenCalledWith({ provider: "p", hidden: true }),
		);
		const authority = { ...withProviderModelsHidden(empty(), "p", true), subagentModels: { scout: "p/a" } };
		response.resolve(authority);
		await done;
		expect(store.getState().modelPrefs).toEqual(authority);
		expect(api.loadModels).toHaveBeenCalledTimes(1);
	});

	it("较早成功返回不会覆盖未发送的单模型例外，后继 IPC 串行", async () => {
		const first = deferred<ModelPrefs>(),
			second = deferred<ModelPrefs>();
		api.setProviderModelsHidden.mockReturnValue(first.promise);
		api.setModelHidden.mockReturnValue(second.promise);
		const a = store.getState().setProviderModelsHidden("p", true);
		const b = store.getState().setModelHidden("p", "a", false);
		expect(store.getState().modelPrefs?.visibleModels).toEqual({ p: ["a"] });
		await vi.waitFor(() => expect(api.setProviderModelsHidden).toHaveBeenCalledTimes(1));
		expect(api.setModelHidden).not.toHaveBeenCalled();
		const authority = { ...withProviderModelsHidden(empty(), "p", true), subagentPreferBuiltin: false };
		first.resolve(authority);
		await vi.waitFor(() => expect(api.setModelHidden).toHaveBeenCalledTimes(1));
		expect(store.getState().modelPrefs).toEqual(withModelHidden(authority, "p", "a", false));
		second.resolve(withModelHidden(authority, "p", "a", false));
		await Promise.all([a, b]);
		expect(api.loadModels).toHaveBeenCalledTimes(2);
	});

	it("失败重读期间不发送后继 IPC；重读发布后只丢失败意图并重放后继操作", async () => {
		const first = deferred<ModelPrefs>(),
			read = deferred<ModelPrefs>(),
			second = deferred<ModelPrefs>();
		api.setProviderModelsHidden.mockReturnValue(first.promise);
		api.getModelPrefs.mockReturnValue(read.promise);
		api.setModelHidden.mockReturnValue(second.promise);
		const a = store.getState().setProviderModelsHidden("p", true);
		const b = store.getState().setModelHidden("q", "b", true);
		await vi.waitFor(() => expect(api.setProviderModelsHidden).toHaveBeenCalledTimes(1));
		first.reject(new Error("Error invoking remote method 'x': Error: disk full"));
		await vi.waitFor(() => expect(api.getModelPrefs).toHaveBeenCalledTimes(1));
		expect(api.setModelHidden).not.toHaveBeenCalled();
		expect(store.getState().modelPrefs).toEqual(withModelHidden(empty(), "q", "b", true));
		const authority = { ...empty(), subagentModels: { scout: "q/a" } };
		read.resolve(authority);
		await vi.waitFor(() => expect(api.setModelHidden).toHaveBeenCalledTimes(1));
		expect(store.getState().modelPrefs).toEqual(withModelHidden(authority, "q", "b", true));
		expect(store.getState().error).toBe("disk full");
		second.resolve(withModelHidden(authority, "q", "b", true));
		await Promise.all([a, b]);
		expect(api.loadModels).toHaveBeenCalledTimes(1);
	});

	it("失败且重读失败：保留最后确认底座，不把 previous 乐观快照当权威", async () => {
		const first = deferred<ModelPrefs>(),
			second = deferred<ModelPrefs>();
		api.setProviderModelsHidden.mockReturnValue(first.promise);
		api.setModelHidden.mockReturnValue(second.promise);
		api.getModelPrefs.mockRejectedValue(new Error("read failed"));
		const a = store.getState().setProviderModelsHidden("p", true);
		const b = store.getState().setModelHidden("p", "b", true);
		await vi.waitFor(() => expect(api.setProviderModelsHidden).toHaveBeenCalledTimes(1));
		first.reject(new Error("write failed"));
		await vi.waitFor(() => expect(api.setModelHidden).toHaveBeenCalledTimes(1));
		const expected = withModelHidden(empty(), "p", "b", true);
		expect(store.getState().modelPrefs).toEqual(expected);
		second.resolve(expected);
		await Promise.all([a, b]);
		expect(store.getState().error).toBe("write failed");
	});

	it("快速连续全藏→例外→全显→全藏不会有旧白名单复活", async () => {
		let disk = empty();
		const order: string[] = [];
		api.setProviderModelsHidden.mockImplementation(async ({ provider, hidden }) => {
			order.push(`provider:${hidden}`);
			disk = withProviderModelsHidden(disk, provider, hidden);
			return disk;
		});
		api.setModelHidden.mockImplementation(async ({ provider, modelId, hidden }) => {
			order.push("model");
			disk = withModelHidden(disk, provider, modelId, hidden);
			return disk;
		});
		await Promise.all([
			store.getState().setProviderModelsHidden("p", true),
			store.getState().setModelHidden("p", "a", false),
			store.getState().setProviderModelsHidden("p", false),
			store.getState().setProviderModelsHidden("p", true),
		]);
		expect(order).toEqual(["provider:true", "model", "provider:false", "provider:true"]);
		expect(store.getState().modelPrefs).toEqual(withProviderModelsHidden(empty(), "p", true));
	});

	it("慢目录返回不能把设置加载时的旧 modelPrefs 覆盖较新的成功返回", async () => {
		const providers = deferred<[]>();
		api.listProviders.mockReturnValue(providers.promise);
		const refresh = store.getState().refresh();
		await vi.waitFor(() => expect(api.getModelPrefs).toHaveBeenCalledTimes(1));
		const authority = withProviderModelsHidden(empty(), "p", true);
		api.setProviderModelsHidden.mockResolvedValue(authority);
		await store.getState().setProviderModelsHidden("p", true);
		providers.resolve([]);
		await refresh;
		expect(store.getState().modelPrefs).toEqual(authority);
	});

	it("加载偏好在途时的点击重放到读回底座上（包括未加载 null 起点）", async () => {
		store.setState({ modelPrefs: null });
		const read = deferred<ModelPrefs>(),
			write = deferred<ModelPrefs>();
		api.getModelPrefs.mockReturnValue(read.promise);
		api.setProviderModelsHidden.mockReturnValue(write.promise);
		const refresh = store.getState().refresh();
		await vi.waitFor(() => expect(api.getModelPrefs).toHaveBeenCalledTimes(1));
		const change = store.getState().setProviderModelsHidden("p", true);
		expect(store.getState().modelPrefs?.hiddenProviders).toEqual(["p"]);
		expect(api.setProviderModelsHidden).not.toHaveBeenCalled();
		const authority = withProviderModelsHidden(empty(), "q", true);
		read.resolve(authority);
		await vi.waitFor(() => expect(api.setProviderModelsHidden).toHaveBeenCalledTimes(1));
		expect(store.getState().modelPrefs).toEqual(withProviderModelsHidden(authority, "p", true));
		write.resolve(withProviderModelsHidden(authority, "p", true));
		await Promise.all([refresh, change]);
	});

	it("修改后的 refresh 读取排队，不向后端索要未提交快照", async () => {
		const write = deferred<ModelPrefs>();
		api.setProviderModelsHidden.mockReturnValue(write.promise);
		const authority = withProviderModelsHidden(empty(), "p", true);
		api.getModelPrefs.mockResolvedValue(authority);
		const change = store.getState().setProviderModelsHidden("p", true);
		const refresh = store.getState().refresh();
		await vi.waitFor(() => expect(api.setProviderModelsHidden).toHaveBeenCalledTimes(1));
		expect(api.getModelPrefs).not.toHaveBeenCalled();
		write.resolve(authority);
		await Promise.all([change, refresh]);
		expect(store.getState().modelPrefs).toEqual(authority);
	});

	it("可见性与所有子代理偏好共用队列，权威快照不互相覆盖", async () => {
		let disk = empty();
		const order: string[] = [];
		api.setProviderModelsHidden.mockImplementation(async ({ provider, hidden }) => {
			order.push("visibility");
			disk = withProviderModelsHidden(disk, provider, hidden);
			return disk;
		});
		api.setSubagentModel.mockImplementation(async ({ agent, modelRef }) => {
			order.push("model");
			disk = { ...disk, subagentModels: { ...disk.subagentModels, [agent]: modelRef } };
			return disk;
		});
		api.setSubagentThinking.mockImplementation(async ({ agent, level }) => {
			order.push("thinking");
			disk = { ...disk, subagentThinking: { ...disk.subagentThinking, [agent]: level } };
			return disk;
		});
		api.setSubagentPreferBuiltin.mockImplementation(async ({ enabled }) => {
			order.push("executor");
			disk = { ...disk, subagentPreferBuiltin: enabled };
			return disk;
		});
		await Promise.all([
			store.getState().setSubagentModel("scout", "p/a"),
			store.getState().setProviderModelsHidden("p", true),
			store.getState().setSubagentThinking("scout", "high"),
			store.getState().setSubagentPreferBuiltin(false),
		]);
		expect(order).toEqual(["model", "visibility", "thinking", "executor"]);
		expect(store.getState().modelPrefs).toEqual({
			hiddenModels: {},
			hiddenProviders: ["p"],
			subagentModels: { scout: "p/a" },
			subagentThinking: { scout: "high" },
			subagentPreferBuiltin: false,
		});
		expect(api.loadModels).toHaveBeenCalledTimes(1);
	});

	it("子代理失败不回滚另一个域的后继乐观操作", async () => {
		api.setSubagentModel.mockRejectedValue(new Error("agent failed"));
		const authority = withProviderModelsHidden(empty(), "p", true);
		api.setProviderModelsHidden.mockResolvedValue(authority);
		await Promise.all([
			store.getState().setSubagentModel("scout", "p/a"),
			store.getState().setProviderModelsHidden("p", true),
		]);
		expect(store.getState().modelPrefs).toEqual(authority);
		expect(store.getState().error).toBe("agent failed");
	});

	it("批量点击固定 ID 快照；单项/批量都经共享隐藏源白名单规则", async () => {
		const hidden = withProviderModelsHidden(empty(), "p", true);
		store.setState({ modelPrefs: hidden });
		const ids = ["a", "b"],
			reply = deferred<ModelPrefs>();
		api.setModelsHidden.mockReturnValue(reply.promise);
		const done = store.getState().setModelsHidden("p", ids, false);
		ids.push("later");
		expect(store.getState().modelPrefs?.visibleModels).toEqual({ p: ["a", "b"] });
		await vi.waitFor(() =>
			expect(api.setModelsHidden).toHaveBeenCalledWith({
				provider: "p",
				modelIds: ["a", "b"],
				hidden: false,
			}),
		);
		reply.resolve(withModelsHidden(hidden, "p", ["a", "b"], false));
		await done;
	});

	it("非法投影不会毒化队列，后续合法修改仍能提交", async () => {
		await expect(store.getState().setProviderModelsHidden(" ", true)).rejects.toThrow(/provider/);
		const authority = withProviderModelsHidden(empty(), "p", true);
		api.setProviderModelsHidden.mockResolvedValue(authority);
		await store.getState().setProviderModelsHidden("p", true);
		expect(store.getState().modelPrefs).toEqual(authority);
		expect(api.setProviderModelsHidden).toHaveBeenCalledTimes(1);
	});
});
