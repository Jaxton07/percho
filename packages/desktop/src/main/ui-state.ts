import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@pi-desktop/backend";
import type { UiState } from "@pi-desktop/shared";
import { app } from "electron";

const log = createLogger("ui-state");

function uiStateFilePath(): string {
	return join(app.getPath("userData"), "ui-state.json");
}

/** 读取持久化 UI 状态；文件缺失/损坏返回 null */
export async function loadUiState(): Promise<UiState | null> {
	try {
		const raw = await readFile(uiStateFilePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<UiState>;
		const model = parsed.currentModel;
		if (model && typeof model.provider !== "string") return null;
		if (model && typeof model.modelId !== "string") return null;
		return {
			currentModel: model ? { provider: model.provider, modelId: model.modelId } : null,
			thinkingLevel: typeof parsed.thinkingLevel === "string" ? parsed.thinkingLevel : "medium",
		};
	} catch {
		return null;
	}
}

/** 持久化 UI 状态（覆盖写入） */
export async function saveUiState(state: UiState): Promise<void> {
	try {
		await writeFile(uiStateFilePath(), JSON.stringify(state, null, 2), "utf-8");
	} catch (err) {
		log.error("ui-state save failed", err);
	}
}
