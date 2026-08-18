import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import { ImagePreviewOverlay } from "../components/chat/ImagePreview";
import { Markdown } from "../components/chat/Markdown";
import { displayName, summarizeArgs } from "../components/chat/ToolCallCard";
import { Button } from "../components/ui/Button";
import { Dropdown } from "../components/ui/Dropdown";
import { Tooltip } from "../components/ui/Tooltip";
import { useContextUsage } from "../hooks/use-context-usage";
import { useLanguage } from "../hooks/use-language";
import { useT } from "../i18n";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { useSettingsStore } from "../stores/settings";
import { useTranscriptStore } from "../stores/transcript";
import { useUiStore } from "../stores/ui";
import type { PerchoUiApi } from "./env";

/**
 * 宿主 API：把宿主能力挂到 window.PerchoUI（插件运行时的唯一入口，与宿主共享同一 React 实例）。
 * 暴露清单与 main/ui-plugins/build.ts 的 SHIMS、Phase 2 的 resources/ui-plugins/percho-ui.d.ts
 * **逐名一致**（新增暴露 = 改这三处 + host-api + shim + percho-ui.d.ts，同步进行）。
 * main.tsx 在 render 前 import 本模块（副作用挂载），确保任何插件代码运行前已就绪。
 */
window.PerchoUI = {
	version: 1,
	// 完整命名空间对象（不是具名导入）：保证插件拿到与宿主同一实例
	React,
	jsxRuntime,
	ReactDOM,
	components: {
		Button,
		Dropdown,
		Tooltip,
		Markdown,
		ImagePreview: ImagePreviewOverlay,
	},
	helpers: {
		summarizeArgs,
		displayToolName: displayName,
	},
	hooks: {
		useT,
		useContextUsage,
		useLanguage,
	},
	stores: {
		useTranscriptStore,
		useSessionsStore,
		useUiStore,
		useProjectsStore,
		useSettingsStore,
	},
} satisfies PerchoUiApi;
