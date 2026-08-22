import { join } from "node:path";
import { createLogger, JsonStore } from "@percho/backend";
import type { SavedTabs } from "@percho/shared";
import { app } from "electron";

const log = createLogger("tabs");

function tabsFilePath(): string {
	return join(app.getPath("userData"), "tabs.json");
}

function tabsStore(): JsonStore<Partial<SavedTabs> | null> {
	return new JsonStore<Partial<SavedTabs> | null>({
		path: tabsFilePath(),
		defaultValue: () => null,
	});
}

/** 读取持久化的顶栏 tabs；文件缺失/损坏返回 null */
export async function loadTabs(): Promise<SavedTabs | null> {
	const parsed = await tabsStore().read();
	if (!parsed) return null;
	if (!Array.isArray(parsed.files)) return null;
	return {
		files: [...new Set(parsed.files.filter((f): f is string => typeof f === "string"))],
		activeFile: typeof parsed.activeFile === "string" ? parsed.activeFile : null,
	};
}

/** 持久化顶栏 tabs（原子写；失败不吞——TabsSave 是 handle，reject 传回 renderer） */
export async function saveTabs(tabs: SavedTabs): Promise<void> {
	try {
		await tabsStore().write(tabs);
	} catch (err) {
		log.error("tabs save failed", err);
		throw err;
	}
}
