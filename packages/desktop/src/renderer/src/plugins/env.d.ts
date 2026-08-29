import type { ImagePreviewOverlay } from "../components/chat/ImagePreview";
import type { Markdown } from "../components/chat/Markdown";
import type { displayName, summarizeArgs } from "../components/chat/ToolCallCard";
import type { Button } from "../components/ui/Button";
import type { Dropdown } from "../components/ui/Dropdown";
import type { Tooltip } from "../components/ui/Tooltip";
import type { useContextUsage } from "../hooks/use-context-usage";
import type { useLanguage } from "../hooks/use-language";
import type { useT } from "../i18n";
import type { useProjectsStore } from "../stores/projects";
import type { useSessionsStore } from "../stores/sessions";
import type { useSettingsStore } from "../stores/settings";
import type { useTranscriptStore } from "../stores/transcript";
import type { useUiStore } from "../stores/ui";
import type { useUiPreferencesStore } from "../stores/ui-preferences";

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
	};
	helpers: {
		summarizeArgs: typeof summarizeArgs;
		displayToolName: typeof displayName;
	};
	hooks: {
		useT: typeof useT;
		useContextUsage: typeof useContextUsage;
		useLanguage: typeof useLanguage;
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
