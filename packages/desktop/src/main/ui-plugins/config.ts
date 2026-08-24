import { join } from "node:path";
import { createLogger, JsonStore } from "@percho/backend";
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

function configStore(): JsonStore<Partial<UiPluginsConfig> | null> {
	return new JsonStore<Partial<UiPluginsConfig> | null>({
		path: uiPluginsConfigPath(),
		defaultValue: () => null,
	});
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
	const parsed = await configStore().read();
	return normalize(parsed ?? {});
}

/**
 * 持久化配置（与现有内容合并后原子写，调用方传补丁即可）。
 * 失败不吞（log 后重抛）：IPC handler 已 await 落盘才返回/推 config 事件，
 * reject 后 renderer 收到失败、不再误推成功事件。
 */
export async function saveUiPluginsConfig(patch: Partial<UiPluginsConfig>): Promise<void> {
	try {
		// 单次 update：读改写整体在 per-path 队列内串行（handler 并发调用不互相覆盖）；
		// 损坏拒写抛 CorruptedError（原为读损坏回退默认后照样覆盖写 = 自愈但静默丢数据）
		await configStore().update((draft) => normalize({ ...(draft ?? {}), ...patch }));
	} catch (err) {
		log.error("ui-plugins config save failed", err);
		throw err;
	}
}
