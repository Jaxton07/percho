import { join } from "node:path";
import { createLogger, JsonStore } from "@percho/backend";
import type { PermissionMode, UiState } from "@percho/shared";
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

/**
 * 按会话记住的权限模式：只收已知枚举值，且**丢掉 `default`**（写侧本就不存，脏文件也归一化掉，文件不会越用越大）。
 */
function permissionModeMap(value: unknown): Record<string, PermissionMode> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, PermissionMode> = {};
	for (const [sessionId, mode] of Object.entries(value as Record<string, unknown>)) {
		if (sessionId === "") continue;
		if (mode === "fullAccess") out[sessionId] = mode;
	}
	return out;
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
	// 展开态：先清洗数组，再用它推断缺字段时的 touched（旧版「非空记录 = 已操作」语义）
	const expandedGroups = stringArray(parsed.expandedGroups);
	return {
		lastUsedModel: model ? { provider: model.provider, modelId: model.modelId } : null,
		lastUsedThinkingLevel: typeof level === "string" ? level : "medium",
		theme,
		background: { image: typeof background?.image === "string" ? background.image : null, dim },
		centerOrbEnabled: typeof parsed.centerOrbEnabled === "boolean" ? parsed.centerOrbEnabled : false,
		// 置顶列表：脏值（手改文件/旧版本）过滤成非空字符串数组（渲染侧另会忽略未知 id）
		pinnedSessions: stringArray(parsed.pinnedSessions),
		sessionPermissionModes: permissionModeMap(parsed.sessionPermissionModes),
		// 顶栏是否显示置顶会话胶囊（旧字段 topBarVisible 已废弃：顶栏现在常驻，不再整条隐藏）
		barSessionsVisible: typeof parsed.barSessionsVisible === "boolean" ? parsed.barSessionsVisible : true,
		sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : false,
		expandedGroups,
		// 显式布尔优先（含显式 false 配空数组）；缺字段/脏值才按清洗后的记录是否非空推断
		expandedGroupsTouched:
			typeof parsed.expandedGroupsTouched === "boolean"
				? parsed.expandedGroupsTouched
				: expandedGroups.length > 0,
		pinnedProjects: stringArray(parsed.pinnedProjects),
		// 上次项目目录：只收非空字符串（旧文件/脏值 → null）
		lastCwd: typeof parsed.lastCwd === "string" && parsed.lastCwd.length > 0 ? parsed.lastCwd : null,
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
