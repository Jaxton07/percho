import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@pi-desktop/backend";
import type { SavedTabs } from "@pi-desktop/shared";
import { app } from "electron";

const log = createLogger("tabs");

function tabsFilePath(): string {
	return join(app.getPath("userData"), "tabs.json");
}

/** 读取持久化的顶栏 tabs；文件缺失/损坏返回 null */
export async function loadTabs(): Promise<SavedTabs | null> {
	try {
		const raw = await readFile(tabsFilePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<SavedTabs>;
		if (!Array.isArray(parsed.files)) return null;
		return {
			files: [...new Set(parsed.files.filter((f): f is string => typeof f === "string"))],
			activeFile: typeof parsed.activeFile === "string" ? parsed.activeFile : null,
		};
	} catch {
		return null;
	}
}

/** 持久化顶栏 tabs（覆盖写入） */
export async function saveTabs(tabs: SavedTabs): Promise<void> {
	try {
		await writeFile(tabsFilePath(), JSON.stringify(tabs, null, 2), "utf-8");
	} catch (err) {
		log.error("tabs save failed", err);
	}
}
