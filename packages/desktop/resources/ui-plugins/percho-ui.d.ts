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
	declare const React: unknown;
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
	declare const ReactDOM: unknown;
	export default ReactDOM;
}

/* ---------- @percho/plugin-api（虚拟模块，构建时重写到 window.PerchoUI） ---------- */

declare module "@percho/plugin-api" {
	export const version: number;

	/** 槽位 props 契约（与 SPEC §2 表一致） */
	export interface SlotProps {
		"chat.tool-call-card": { tool: UIToolCall };
		"chat.subagent-card": { runs: SubagentRunUi[] };
		"chat.todo-panel": Record<string, never>;
	}

	/** 上下文使用量（useContextUsage 返回值；percent/tokens 为 null 表示未知） */
	export interface ContextUsageInfo {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	}

	export interface UIToolCall {
		key: string;
		id: string;
		name: string;
		args: string;
		output: string;
		state: "running" | "done" | "error";
		blockIndex?: number;
	}

	export interface SubagentRunUi {
		key: string;
		agent: string;
		task?: string;
		status: "running" | "done" | "error";
		model?: string;
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
		/** 当前界面语言（"zh" | "en"）——插件自有文案跟随中英 */
		useLanguage(): "zh" | "en";
	};
	export const stores: {
		useTranscriptStore: unknown;
		useSessionsStore: unknown;
		useUiStore: unknown;
		useProjectsStore: unknown;
		useSettingsStore: unknown;
		/** 应用级 UI 偏好（ui-state.json 持久化）：sessionRailEnabled / centerOrbEnabled 等 */
		useUiPreferencesStore: unknown;
	};
	// store hooks 顶层便捷导出（与 shim 解构一致，例：import { useSessionsStore } from "@percho/plugin-api"）
	export const useTranscriptStore: unknown;
	export const useSessionsStore: unknown;
	export const useUiStore: unknown;
	export const useProjectsStore: unknown;
	export const useSettingsStore: unknown;
	export const useUiPreferencesStore: unknown;
	declare const api: unknown;
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
