import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@percho/backend";
import type { UiPluginsConfig } from "@percho/shared";
import { app } from "electron";

const log = createLogger("ui-plugins-config");

/** 配置损坏/缺失时返回的默认值（首次发布保守默认：总开关关、无插件、无指派） */
export function defaultUiPluginsConfig(): UiPluginsConfig {
	return { enabled: false, plugins: {}, assignments: {} };
}

function uiPluginsConfigPath(): string {
	return join(app.getPath("userData"), "ui-plugins.json");
}

/** 字段校验 + 默认值填充（未知字段丢弃；enabled/trusted 必须 boolean 否则归默认） */
function normalize(parsed: Partial<UiPluginsConfig>): UiPluginsConfig {
	const plugins: UiPluginsConfig["plugins"] = {};
	if (parsed.plugins && typeof parsed.plugins === "object") {
		for (const [name, p] of Object.entries(parsed.plugins)) {
			if (!p || typeof p !== "object") continue;
			plugins[name] = {
				enabled: typeof p.enabled === "boolean" ? p.enabled : false,
				trusted: typeof p.trusted === "boolean" ? p.trusted : false,
			};
		}
	}
	// assignments 指向不存在/未启用插件的条目保留但运行时忽略（不主动清理，避免与扫描时序打架）
	const assignments: UiPluginsConfig["assignments"] = {};
	if (parsed.assignments && typeof parsed.assignments === "object") {
		for (const [slot, name] of Object.entries(parsed.assignments)) {
			if (typeof name === "string") assignments[slot] = name;
		}
	}
	return {
		enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
		plugins,
		assignments,
	};
}

/** 读取持久化配置；文件缺失/损坏返回默认（不是 null：配置损坏不应阻塞插件系统） */
export async function loadUiPluginsConfig(): Promise<UiPluginsConfig> {
	try {
		const raw = await readFile(uiPluginsConfigPath(), "utf-8");
		return normalize(JSON.parse(raw) as Partial<UiPluginsConfig>);
	} catch {
		return defaultUiPluginsConfig();
	}
}

/** 持久化配置（与现有内容合并后覆盖写入，调用方传补丁即可；写失败只告警不致命） */
export async function saveUiPluginsConfig(patch: Partial<UiPluginsConfig>): Promise<void> {
	try {
		const existing = await loadUiPluginsConfig();
		const merged: UiPluginsConfig = normalize({ ...existing, ...patch });
		await writeFile(uiPluginsConfigPath(), JSON.stringify(merged, null, 2), "utf-8");
	} catch (err) {
		log.error("ui-plugins config save failed", err);
	}
}
