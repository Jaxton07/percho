import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@percho/backend";
import type { UiState } from "@percho/shared";
import { app } from "electron";

const log = createLogger("ui-state");

function uiStateFilePath(): string {
	return join(app.getPath("userData"), "ui-state.json");
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
	};
}

/** 读取持久化 UI 状态；文件缺失/损坏返回 null */
export async function loadUiState(): Promise<UiState | null> {
	try {
		const raw = await readFile(uiStateFilePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<UiState>;
		const model = parsed.currentModel;
		if (model && typeof model.provider !== "string") return null;
		if (model && typeof model.modelId !== "string") return null;
		return normalize(parsed);
	} catch {
		return null;
	}
}

/** 持久化 UI 状态（与现有内容浅合并后覆盖写入，调用方传补丁即可） */
export async function saveUiState(patch: Partial<UiState>): Promise<void> {
	try {
		const existing = await loadUiState();
		const merged: UiState = normalize({ ...existing, ...patch });
		await writeFile(uiStateFilePath(), JSON.stringify(merged, null, 2), "utf-8");
	} catch (err) {
		log.error("ui-state save failed", err);
	}
}
