import type {
	McpConfigListResult,
	McpServerView,
	McpToolsChangedPayload,
	McpUpsertInput,
} from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useToastsStore } from "./toasts";

interface McpStore {
	/** 最近一次 mcp.configList 结果（null = 未加载） */
	config: McpConfigListResult | null;
	loading: boolean;
	/** 运行态「server → 工具名」快照（由 mcp.tools:changed 事件维护，初次打开时为空） */
	toolsByServer: Record<string, string[]>;
	load: (cwd?: string) => Promise<void>;
	upsert: (input: McpUpsertInput) => Promise<void>;
	remove: (input: { scope: "user" | "project"; cwd?: string; name: string }) => Promise<void>;
	/** 重连：reload 会话让官方 mcp 扩展重读配置重连（等价官方 /mcp 的 reconnect） */
	reload: (cwd?: string) => Promise<void>;
	/** 事件入口（main 转发 `mcp.tools:changed`） */
	applyToolsChanged: (payload: McpToolsChangedPayload) => void;
}

/** 工具名合并进 server 视图（运行态优先，配置里的 server 一律带 tools 数组） */
function mergeTools(
	config: McpConfigListResult,
	toolsByServer: Record<string, string[]>,
): McpConfigListResult {
	const withTools = (servers: McpServerView[]) =>
		servers.map((server) => ({ ...server, tools: toolsByServer[server.name] ?? server.tools }));
	return { ...config, global: withTools(config.global), project: withTools(config.project) };
}

export const useMcpStore = create<McpStore>((set, get) => ({
	config: null,
	loading: false,
	toolsByServer: {},

	load: async (cwd) => {
		set({ loading: true });
		try {
			const config = await getPi().mcpConfigList({ cwd });
			set({ config: mergeTools(config, get().toolsByServer), loading: false });
		} catch (error) {
			set({ loading: false });
			useToastsStore.getState().push("error", "toast.mcpLoadFailed");
			console.error("MCP 配置读取失败", error);
		}
	},

	upsert: async (input) => {
		const config = await getPi().mcpConfigUpsert(input);
		set({ config: mergeTools(config, get().toolsByServer) });
	},

	remove: async (input) => {
		const config = await getPi().mcpConfigRemove(input);
		set({ config: mergeTools(config, get().toolsByServer) });
	},

	reload: async (cwd) => {
		const config = await getPi().mcpConfigReload({ cwd });
		set({ config: mergeTools(config, get().toolsByServer) });
	},

	applyToolsChanged: ({ servers }) => {
		const toolsByServer = Object.fromEntries(servers.map((s) => [s.name, s.tools]));
		const config = get().config;
		set({ toolsByServer, config: config ? mergeTools(config, toolsByServer) : config });
	},
}));
