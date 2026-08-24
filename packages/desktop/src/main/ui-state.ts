import { join } from "node:path";
import { createLogger, JsonStore } from "@percho/backend";
import type { UiState } from "@percho/shared";
import { app } from "electron";

const log = createLogger("ui-state");

function uiStateFilePath(): string {
	return join(app.getPath("userData"), "ui-state.json");
}

function uiStateStore(): JsonStore<Partial<UiState> | null> {
	return new JsonStore<Partial<UiState> | null>({
		path: uiStateFilePath(),
		defaultValue: () => null,
	});
}

/** 字段校验 + 默认值填充（旧版本文件缺 theme/background 时补齐） */
function normalize(parsed: Partial<UiState>): UiState {
	const model = parsed.currentModel;
	const theme =
		parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
			? parsed.theme
			: "system";
	const background = parsed.background;
	const dim =
		typeof background?.dim === "number" && background.dim >= 0 && background.dim <= 1 ? background.dim : 0.8;
	return {
		currentModel: model ? { provider: model.provider, modelId: model.modelId } : null,
		thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : "medium",
		theme,
		background: { image: typeof background?.image === "string" ? background.image : null, dim },
		sessionRailEnabled: typeof parsed.sessionRailEnabled === "boolean" ? parsed.sessionRailEnabled : false,
		centerOrbEnabled: typeof parsed.centerOrbEnabled === "boolean" ? parsed.centerOrbEnabled : false,
	};
}

/** 读取持久化 UI 状态；文件缺失/损坏返回 null（读损坏回退语义保持，不阻塞启动） */
export async function loadUiState(): Promise<UiState | null> {
	const parsed = await uiStateStore().read();
	if (!parsed) return null;
	const model = parsed.currentModel;
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
