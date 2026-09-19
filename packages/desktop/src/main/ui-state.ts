import { join } from "node:path";
import { createLogger, JsonStore } from "@percho/backend";
import type { UiState } from "@percho/shared";
import { app } from "electron";

const log = createLogger("ui-state");

function uiStateFilePath(): string {
	return join(app.getPath("userData"), "ui-state.json");
}

/** 旧版（2026-09 前）文件字段：读取时迁移进 lastUsed*，下次保存随 normalize 重建自然清除 */
type UiStateFileShape = Partial<UiState> & {
	currentModel?: { provider: string; modelId: string } | null;
	thinkingLevel?: string;
};

function uiStateStore(): JsonStore<UiStateFileShape | null> {
	return new JsonStore<UiStateFileShape | null>({
		path: uiStateFilePath(),
		defaultValue: () => null,
	});
}

/** 字符串数组字段校验：非数组 → 丢弃，非字符串/空串元素 → 过滤（渲染侧另会忽略未知 id） */
function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item !== "")
		: [];
}

/** 字段校验 + 默认值填充（旧版本文件缺 theme/background 时补齐） */
function normalize(parsed: UiStateFileShape): UiState {
	const model = parsed.lastUsedModel ?? parsed.currentModel;
	const level = parsed.lastUsedThinkingLevel ?? parsed.thinkingLevel;
	const theme =
		parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
			? parsed.theme
			: "system";
	const background = parsed.background;
	const dim =
		typeof background?.dim === "number" && background.dim >= 0 && background.dim <= 1 ? background.dim : 0.8;
	return {
		lastUsedModel: model ? { provider: model.provider, modelId: model.modelId } : null,
		lastUsedThinkingLevel: typeof level === "string" ? level : "medium",
		theme,
		background: { image: typeof background?.image === "string" ? background.image : null, dim },
		sessionRailEnabled: typeof parsed.sessionRailEnabled === "boolean" ? parsed.sessionRailEnabled : false,
		centerOrbEnabled: typeof parsed.centerOrbEnabled === "boolean" ? parsed.centerOrbEnabled : false,
		// 置顶列表：脏值（手改文件/旧版本）过滤成非空字符串数组（渲染侧另会忽略未知 id）
		pinnedSessions: stringArray(parsed.pinnedSessions),
		topBarVisible: typeof parsed.topBarVisible === "boolean" ? parsed.topBarVisible : true,
		sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : false,
		expandedGroups: stringArray(parsed.expandedGroups),
		pinnedProjects: stringArray(parsed.pinnedProjects),
		sessionListMode: parsed.sessionListMode === "floating" ? "floating" : "tabbar",
	};
}

/** 读取持久化 UI 状态；文件缺失/损坏返回 null（读损坏回退语义保持，不阻塞启动） */
export async function loadUiState(): Promise<UiState | null> {
	const parsed = await uiStateStore().read();
	if (!parsed) return null;
	const model = parsed.lastUsedModel ?? parsed.currentModel;
	if (model && typeof model.provider !== "string") return null;
	if (model && typeof model.modelId !== "string") return null;
	return normalize(parsed);
}

/** 持久化 UI 状态（与现有内容浅合并后原子写，调用方传补丁即可；失败不吞，UiStateSave 是 handle） */
export async function saveUiState(patch: Partial<UiState>): Promise<void> {
	try {
		// 单次 update：读改写整体在 per-path 队列内串行（并发 patch 不互相覆盖）
		await uiStateStore().update((draft) => normalize({ ...(draft ?? {}), ...patch }));
	} catch (err) {
		log.error("ui-state save failed", err);
		throw err;
	}
}
