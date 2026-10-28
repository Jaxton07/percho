import type {
	McpConfigListResult,
	McpGlobalNotice,
	McpReloadReport,
	McpServerStatus,
	McpServersChangedPayload,
	McpServerView,
	McpUpsertInput,
} from "@percho/shared";
import { type EnvironmentRef, environmentKey, environmentRef, LOCAL_ENVIRONMENT } from "@percho/shared";
import { create, useStore } from "zustand";
import { getExecutionApi } from "../environment-api";
import { useEnvironment } from "../environment-context";
import { useToastsStore } from "./toasts";

interface McpStore {
	/** 最近一次 mcp.configList 结果（null = 未加载） */
	config: McpConfigListResult | null;
	loading: boolean;
	/** 运行态快照（由 `mcp.servers:changed` 事件维护；初次打开时以 configList 里的为准） */
	status: Record<string, McpServerStatus>;
	/** 官方 notify 的全局提示（工具不可达 / 配置错误） */
	notice?: McpGlobalNotice;
	/** 最近一次写盘/重连的 reload 结果（面板提示「已重连 N / M 个运行中未重连」） */
	lastReload: McpReloadReport | null;
	load: (cwd?: string) => Promise<void>;
	upsert: (input: McpUpsertInput) => Promise<void>;
	remove: (input: { scope: "user" | "project"; cwd?: string; name: string }) => Promise<void>;
	/** 重连：reload 空闲会话让官方 mcp 扩展重读配置重连（运行中的会话会被跳过并回报） */
	reload: (cwd?: string) => Promise<void>;
	/** 事件入口（main 转发 `mcp.servers:changed`） */
	applyServersChanged: (payload: McpServersChangedPayload) => void;
}

/** 把运行态合流进视图（工具 / 失败原因 / 需登录都以运行态为准，configList 里的同名字段只作兜底） */
function mergeStatus(
	config: McpConfigListResult,
	status: Record<string, McpServerStatus>,
): McpConfigListResult {
	const withStatus = (servers: McpServerView[]) =>
		servers.map((server) => {
			const live = status[server.name];
			if (!live) return server;
			return {
				...server,
				tools: live.tools.length > 0 ? live.tools : server.tools,
				error: live.error ?? server.error,
				needsAuth: live.needsAuth ?? server.needsAuth,
			};
		});
	return { ...config, global: withStatus(config.global), project: withStatus(config.project) };
}

/** 运行态快照也带一份视图（configList 的 tools 只是打开面板那一刻的快照） */
function statusFrom(config: McpConfigListResult): Record<string, McpServerStatus> {
	const entries = [...config.global, ...config.project].map((server) => [
		server.name,
		{ name: server.name, tools: server.tools, error: server.error, needsAuth: server.needsAuth },
	]);
	return Object.fromEntries(entries) as Record<string, McpServerStatus>;
}

function createMcpStore(environment: EnvironmentRef) {
	return create<McpStore>((set, get) => {
		let loadSeq = 0;
		return {
			config: null,
			loading: false,
			status: {},
			lastReload: null,

			load: async (cwd) => {
				const seq = ++loadSeq;
				set({ loading: true });
				try {
					const config = await getExecutionApi(environment).mcpConfigList({ cwd });
					if (seq !== loadSeq) return;
					const status = { ...statusFrom(config), ...get().status };
					set({ config: mergeStatus(config, status), status, notice: config.notice, loading: false });
				} catch (error) {
					if (seq !== loadSeq) return;
					set({ loading: false });
					useToastsStore.getState().push("error", "toast.mcpLoadFailed");
					console.error("MCP 配置读取失败", error);
				}
			},

			upsert: async (input) => {
				const { config, reload } = await getExecutionApi(environment).mcpConfigUpsert(input);
				set({
					config: mergeStatus(config, get().status),
					notice: config.notice,
					lastReload: reload,
				});
			},

			remove: async (input) => {
				const { config, reload } = await getExecutionApi(environment).mcpConfigRemove(input);
				set({ config: mergeStatus(config, get().status), notice: config.notice, lastReload: reload });
			},

			reload: async (cwd) => {
				const { config, reload } = await getExecutionApi(environment).mcpConfigReload({ cwd });
				set({ config: mergeStatus(config, get().status), notice: config.notice, lastReload: reload });
			},

			applyServersChanged: ({ servers, notice }) => {
				const status = Object.fromEntries(servers.map((server) => [server.name, server])) as Record<
					string,
					McpServerStatus
				>;
				const config = get().config;
				set({ status, notice, config: config ? mergeStatus(config, status) : config });
			},
		};
	});
}

const stores = new Map<string, ReturnType<typeof createMcpStore>>();
export function getMcpStore(reference: EnvironmentRef = LOCAL_ENVIRONMENT) {
	const environment = environmentRef(reference);
	const key = environmentKey(environment);
	let store = stores.get(key);
	if (!store) {
		store = createMcpStore(environment);
		stores.set(key, store);
	}
	return store;
}
const localStore = getMcpStore();
export const useLocalMcpStore = localStore;
function useBoundMcpStore<T = McpStore>(selector?: (state: McpStore) => T): T {
	const store = getMcpStore(useEnvironment());
	return useStore(store, selector ?? ((state) => state as unknown as T));
}
// Static access is the local compatibility entry. Environment operations use getMcpStore(ref).
export const useMcpStore = Object.assign(useBoundMcpStore, localStore);
