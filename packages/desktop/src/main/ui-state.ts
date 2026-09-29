import { join } from "node:path";
import { createLogger, JsonStore } from "@percho/backend";
import type { PermissionMode, SessionWorkspaceSnapshot, UiState } from "@percho/shared";
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

/** 会话文件路径数组清洗：trim → 去空 → 去重（保序）。与 `stringArray` 分开，不动它的既有语义 */
function filePathArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const path = item.trim();
		if (path === "" || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

/**
 * 工作区快照归一化：清洗 `files`（trim/去空/去重），`activeFile` 必须 ∈ files（否则 null）。
 * **两个显示入口都关掉时强制清空**：关掉两处 = 清空工作区并停止采集（spec），
 * 旧文件里可能留着上次的快照 —— 不清掉会在下次开启时隔空复活一排胶囊。
 */
function workspaceSnapshot(
	value: unknown,
	barVisible: boolean,
	railEnabled: boolean,
): SessionWorkspaceSnapshot {
	if (!barVisible && !railEnabled) return { files: [], activeFile: null };
	const raw = (value ?? {}) as Partial<SessionWorkspaceSnapshot>;
	const files = filePathArray(raw.files);
	const active = typeof raw.activeFile === "string" ? raw.activeFile.trim() : "";
	return { files, activeFile: active !== "" && files.includes(active) ? active : null };
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
	const barSessionsVisible =
		typeof parsed.barSessionsVisible === "boolean" ? parsed.barSessionsVisible : true;
	// 轨道开关缺省 false：老用户的 `barSessionsVisible:false` 缺 rail 字段时 = 双关 → 保持关 + 工作区空
	const sessionRailEnabled =
		typeof parsed.sessionRailEnabled === "boolean" ? parsed.sessionRailEnabled : false;
	return {
		lastUsedModel: model ? { provider: model.provider, modelId: model.modelId } : null,
		lastUsedThinkingLevel: typeof level === "string" ? level : "medium",
		theme,
		background: { image: typeof background?.image === "string" ? background.image : null, dim },
		centerOrbEnabled: typeof parsed.centerOrbEnabled === "boolean" ? parsed.centerOrbEnabled : false,
		// 置顶列表：脏值（手改文件/旧版本）过滤成非空字符串数组（渲染侧另会忽略未知 id）
		pinnedSessions: stringArray(parsed.pinnedSessions),
		sessionPermissionModes: permissionModeMap(parsed.sessionPermissionModes),
		// 顶栏是否显示工作区胶囊（旧字段 topBarVisible 已废弃：顶栏现在常驻，不再整条隐藏）
		barSessionsVisible,
		sessionRailEnabled,
		sessionWorkspace: workspaceSnapshot(parsed.sessionWorkspace, barSessionsVisible, sessionRailEnabled),
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
