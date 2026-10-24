import type { ImagePreviewOverlay } from "../components/chat/ImagePreview";
import type { Markdown } from "../components/chat/Markdown";
import type { displayName, summarizeArgs } from "../components/chat/ToolCallCard";
import type { Button } from "../components/ui/Button";
import type { Dropdown } from "../components/ui/Dropdown";
import type { Switch } from "../components/ui/Switch";
import type { Tooltip } from "../components/ui/Tooltip";
import type { useContextUsage } from "../hooks/use-context-usage";
import type { useLanguage } from "../hooks/use-language";
import type { useQuota } from "../hooks/use-quota";
import type { useT } from "../i18n";
import type { useProjectsStore } from "../stores/projects";
import type { useSessionsStore } from "../stores/sessions";
import type { useSettingsStore } from "../stores/settings";
import type { useTranscriptStore } from "../stores/transcript";
import type { useUiStore } from "../stores/ui";
import type { useUiPreferencesStore } from "../stores/ui-preferences";
import type { usePluginSettings } from "./use-plugin-settings";

/** window.PerchoUI 的类型（插件与宿主自身代码共用；与 host-api.ts 的挂载内容一一对应） */
export interface PerchoUiApi {
	version: 1;
	/** 完整命名空间对象（与宿主同一 React 实例） */
	React: typeof import("react");
	jsxRuntime: typeof import("react/jsx-runtime");
	ReactDOM: typeof import("react-dom");
	components: {
		Button: typeof Button;
		Dropdown: typeof Dropdown;
		Tooltip: typeof Tooltip;
		Markdown: typeof Markdown;
		ImagePreview: typeof ImagePreviewOverlay;
		/** 开关控件（行为/可访问性由宿主保证，样式与设置面板一致） */
		Switch: typeof Switch;
	};
	helpers: {
		summarizeArgs: typeof summarizeArgs;
		displayToolName: typeof displayName;
	};
	hooks: {
		useT: typeof useT;
		useContextUsage: typeof useContextUsage;
		useQuota: typeof useQuota;
		useLanguage: typeof useLanguage;
		/** 插件自有配置读写（perchoUi 2）：值只可能是 JSON 标量，宿主有界校验后落盘 */
		usePluginSettings: typeof usePluginSettings;
	};
	stores: {
		useTranscriptStore: typeof useTranscriptStore;
		useSessionsStore: typeof useSessionsStore;
		useUiStore: typeof useUiStore;
		useProjectsStore: typeof useProjectsStore;
		useSettingsStore: typeof useSettingsStore;
		useUiPreferencesStore: typeof useUiPreferencesStore;
	};
}

declare global {
	interface Window {
		PerchoUI: PerchoUiApi;
	}
}
