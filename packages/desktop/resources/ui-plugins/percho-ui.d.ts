/**
 * Percho UI 插件 API 类型声明。
 * ⚠️ 与宿主 `packages/desktop/src/main/ui-plugins/build.ts` 的 SHIMS、`plugins/host-api.ts`
 * 的挂载内容**逐名一致**（三处不可漂移）——agent 写代码时类型来源就是本文件，
 * 少一个名字 agent 就会写出跑不起来的插件。宿主侧新增暴露时同步本文件。
 */

/* ---------- react（虚拟模块，构建时重写到 window.PerchoUI.React） ---------- */

declare module "react" {
	export type ReactNode = unknown;
	export type ComponentType<P = Record<string, never>> = unknown;
	export type ReactElement = unknown;

	export const Children: unknown;
	export const Component: unknown;
	export const Fragment: unknown;
	export const PureComponent: unknown;
	export const StrictMode: unknown;
	export const Suspense: unknown;
	export const cloneElement: unknown;
	export const createContext: unknown;
	export const createElement: unknown;
	export const createRef: unknown;
	export const forwardRef: unknown;
	export const isValidElement: unknown;
	export const lazy: unknown;
	export const memo: <P>(component: (props: P) => ReactNode) => unknown;
	export const startTransition: unknown;
	export const use: unknown;
	export const useActionState: unknown;
	export const useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T;
	export const useContext: <T>(ctx: unknown) => T;
	export const useDebugValue: unknown;
	export const useDeferredValue: unknown;
	export const useEffect: (effect: () => unknown, deps?: unknown[]) => void;
	export const useId: () => string;
	export const useImperativeHandle: unknown;
	export const useInsertionEffect: unknown;
	export const useLayoutEffect: unknown;
	export const useMemo: <T>(factory: () => T, deps: unknown[]) => T;
	export const useOptimistic: unknown;
	export const useReducer: unknown;
	export const useRef: <T>(init: T) => { current: T };
	export const useState: <T>(init: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
	export const useSyncExternalStore: unknown;
	export const useTransition: unknown;
	export const version: string;
	const React: unknown;
	export default React;
}

declare module "react/jsx-runtime" {
	export const jsx: unknown;
	export const jsxs: unknown;
	export const Fragment: unknown;
}

declare module "react-dom" {
	export const createPortal: unknown;
	export const flushSync: unknown;
	const ReactDOM: unknown;
	export default ReactDOM;
}

/* ---------- @percho/plugin-api（虚拟模块，构建时重写到 window.PerchoUI） ---------- */

declare module "@percho/plugin-api" {
	export const version: number;

	/** 槽位 props 契约（与 SPEC §2 表一致） */
	export interface SlotProps {
		"chat.subagent-card": { runs: SubagentRunUi[] };
		"chat.todo-panel": Record<string, never>;
	}

	/** 上下文使用量（useContextUsage 返回值；percent/tokens 为 null 表示未知） */
	export interface ContextUsageInfo {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	}

	/** 一组 LLM 消息的聚合速度（speed = null ⇒ 无有效样本） */
	export interface SpeedAggregate {
		/** Σ 输出 token（API 权威值，非估算） */
		outputTokens: number;
		/** Σ api 时长（ms）：含 prefill/网络，不含工具执行/排队 */
		durationMs: number;
		/** Σ prompt 规模（input + cacheRead + cacheWrite） */
		promptTokens: number;
		/** 有效样本数（计入的 LLM 消息条数） */
		samples: number;
		speed: number | null;
	}

	/** 一轮的速度（turnIndex 与轮末计时器同规则，从 0 计） */
	export interface SpeedTurn extends SpeedAggregate {
		turnIndex: number;
		/** 本轮最后一个有 model 的样本 */
		model?: string;
	}

	/**
	 * token 生成速度视图（useTurnSpeed 返回值）。
	 * 口径必须可辨：api 含 prefill/网络（长 prompt 轮可低 30%+），decode 已剔除 prefill；
	 * wall 口径（含工具执行/排队）不在本视图内，实测会稀释 ≈7×。
	 */
	export interface TurnSpeedView {
		/** 展示口径：decode = 已用实测 TTFT 剔除 prefill；api = 含 prefill/网络 */
		metric: "decode" | "api";
		/** metric 对应的速度（tok/s） */
		speed: number;
		apiSpeed: number | null;
		decodeSpeed: number | null;
		/** metric 口径的分子（token）与分母（ms） */
		outputTokens: number;
		durationMs: number;
		/** 当前轮 Σ api 时长；Σ 实测 prefill（null = 本轮无可拆分样本） */
		apiMs: number;
		prefillMs: number | null;
		promptTokens: number;
		samples: number;
		model?: string;
		/** 本轮是否仍在生成 */
		live: boolean;
		/** 流式期间累计估算 token（非权威，仅供“正在生成”动态指示） */
		liveTokens: number | null;
		/** 流式期间滚动窗口速率（估算 tok/s） */
		liveSpeed: number | null;
		/** 最近若干轮（含当前轮）；历史轮同样有速度 */
		turns: SpeedTurn[];
		/** 全会话累计 */
		session: SpeedAggregate;
	}

	/** opencode-go 套餐额度窗口 key（5h 滚动 / 日历周 / 计费月） */
	export type QuotaWindowKey = "rolling" | "weekly" | "monthly";

	/** opencode-go 套餐额度单窗口 */
	export interface QuotaWindow {
		key: QuotaWindowKey;
		/** 短标签（5h / week / month，插件按需本地化） */
		label: string;
		/** 已用百分比（0-100） */
		percent: number;
		/** ISO 重置时间，无则 null */
		resetsAt: string | null;
		/** 估算已用美元（percent × limit），未知为 null */
		usedUsd: number | null;
		/** 窗口上限美元（rolling 12 / weekly 30 / monthly 60） */
		limitUsd: number;
		status: "ok" | "rate-limited";
	}

	/**
	 * opencode-go 套餐额度（main 进程拉官方 API，5 分钟 TTL）。
	 * null = 无 key/无订阅（插件应隐藏）；error 非空 = 拉取失败（插件可展示错误态）。
	 */
	export interface QuotaInfo {
		windows: QuotaWindow[];
		updatedAt: number;
		error?: string;
	}

	export interface SubagentRunSummary {
		changedFiles: Array<{ path: string; added: number; removed: number }>;
		commands: Array<{ command: string; isError: boolean }>;
		failedCommands: number;
		durationMs: number;
	}

	export interface SubagentRunUi {
		key: string;
		agent: string;
		task?: string;
		status: "running" | "done" | "error" | "queued" | "aborted";
		summary?: SubagentRunSummary;
		index?: number;
		model?: string;
		thinkingLevel?: string;
		tokens?: number;
		exitCode?: number;
		artifactsDir?: string;
		sessionFile?: string;
	}

	/** 宿主精选组件 props（宽松化：与宿主内部类型同构，不逐字段绑定） */
	export interface PluginButtonProps {
		children?: unknown;
		onClick?: () => void;
		disabled?: boolean;
		className?: string;
		title?: string;
	}
	export interface PluginTooltipProps {
		label: string;
		children: unknown;
	}
	export interface PluginMarkdownProps {
		text: string;
		streaming?: boolean;
	}
	export interface PluginImagePreviewProps {
		image: { data: string; mimeType: string };
		onClose: () => void;
	}

	export const components: {
		Button: (props: PluginButtonProps) => unknown;
		Dropdown: (props: { trigger: unknown; children: (close: () => void) => unknown }) => unknown;
		Tooltip: (props: PluginTooltipProps) => unknown;
		Markdown: (props: PluginMarkdownProps) => unknown;
		ImagePreview: (props: PluginImagePreviewProps) => unknown;
	};
	export const helpers: {
		summarizeArgs(args: string): string;
		displayToolName(name: string): string;
	};
	export const hooks: {
		useT(): (key: string, params?: Record<string, string | number>) => string;
		/** 上下文使用量（事件驱动刷新；sessionId 为 null/draft 时返回 null）——token 仪表盘用 */
		useContextUsage(sessionId: string | null): ContextUsageInfo | null;
		/** opencode-go 套餐额度（全局；无 key/无订阅返回 null，插件应隐藏；turn 结束刷新 + 60s 轮询）——额度圆环用 */
		useQuota(): QuotaInfo | null;
		/**
		 * token 生成速度（事件驱动刷新：assistant message_end/turn_end/agent_settled/session_info_changed/
		 * compaction_end；流式期间另有 live 估算每 500ms 刷新）。返回 null = 无任何可用数据（含 live），
		 * 插件应隐藏。展示时必须标出口径（metric），api 与 decode 不可裸比较。——token 速度用 */
		useTurnSpeed(sessionId: string | null): TurnSpeedView | null;
		/** 当前界面语言（"zh" | "en"）——插件自有文案跟随中英 */
		useLanguage(): "zh" | "en";
	};
	export const stores: {
		useTranscriptStore: unknown;
		useSessionsStore: unknown;
		useUiStore: unknown;
		useProjectsStore: unknown;
		useSettingsStore: unknown;
		/** 应用级 UI 偏好（ui-state.json 持久化）：barSessionsVisible / sidebarCollapsed / centerOrbEnabled 等 */
		useUiPreferencesStore: unknown;
	};
	// 具名便捷导出复用分组声明，不另写一套props/签名。
	export const Button: typeof components.Button;
	export const Dropdown: typeof components.Dropdown;
	export const Tooltip: typeof components.Tooltip;
	export const Markdown: typeof components.Markdown;
	export const ImagePreview: typeof components.ImagePreview;
	export const summarizeArgs: typeof helpers.summarizeArgs;
	export const displayToolName: typeof helpers.displayToolName;
	export const useT: typeof hooks.useT;
	export const useContextUsage: typeof hooks.useContextUsage;
	export const useQuota: typeof hooks.useQuota;
	export const useTurnSpeed: typeof hooks.useTurnSpeed;
	export const useLanguage: typeof hooks.useLanguage;
	// store hooks 顶层便捷导出（与 shim 解构一致，例：import { useSessionsStore } from "@percho/plugin-api"）
	export const useTranscriptStore: unknown;
	export const useSessionsStore: unknown;
	export const useUiStore: unknown;
	export const useProjectsStore: unknown;
	export const useSettingsStore: unknown;
	export const useUiPreferencesStore: unknown;
	const api: unknown;
	export default api;
}

/* ---------- 静态资产（构建器 dataurl loader 内联为 data: URL，SPEC §3/§11） ---------- */

/* 图片：CSP img-src data: */
declare module "*.png" {
	const url: string;
	export default url;
}
declare module "*.webp" {
	const url: string;
	export default url;
}
declare module "*.gif" {
	const url: string;
	export default url;
}
declare module "*.jpg" {
	const url: string;
	export default url;
}
declare module "*.jpeg" {
	const url: string;
	export default url;
}

/* 音频：CSP media-src data:，new Audio(url) 播放（语音提醒/音效类插件用） */
declare module "*.mp3" {
	const url: string;
	export default url;
}
declare module "*.m4a" {
	const url: string;
	export default url;
}
declare module "*.wav" {
	const url: string;
	export default url;
}
declare module "*.ogg" {
	const url: string;
	export default url;
}
declare module "*.aac" {
	const url: string;
	export default url;
}
