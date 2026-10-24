import { join } from "node:path";
import { createLogger, JsonStore } from "@percho/backend";
import type { UiPluginSettingValue, UiPluginsConfig } from "@percho/shared";
import { app } from "electron";
import { applySettingsPatch, normalizeSettingsVersion, sanitizePluginSettings } from "./settings";

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
			// 插件自有配置：非法形状不阻塞插件系统，直接当作"没有配置"
			const settings = sanitizePluginSettings((p as { settings?: unknown }).settings);
			if (settings) plugins[name].settings = settings;
			// 迁移进度：只在合法时保留，其它当"从未迁移"（宿主下次读设置会重跑迁移）
			const version = normalizeSettingsVersion((p as { settingsVersion?: unknown }).settingsVersion);
			if (version > 0) plugins[name].settingsVersion = version;
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

/** 读某个插件的自有配置（不存在返回空对象；调用方只读，不要改返回值） */
export async function loadPluginSettings(name: string): Promise<Record<string, UiPluginSettingValue>> {
	const config = await loadUiPluginsConfig();
	return config.plugins[name]?.settings ?? {};
}

/** 读取持久化配置；文件缺失/损坏返回默认（不是 null：配置损坏不应阻塞插件系统） */
export async function loadUiPluginsConfig(): Promise<UiPluginsConfig> {
	const parsed = await configStore().read();
	return normalize(parsed ?? {});
}

export type UiPluginsConfigCommand =
	| { kind: "set-enabled"; enabled: boolean }
	| { kind: "set-plugin-enabled"; name: string; enabled: boolean }
	| { kind: "assign-slot"; slot: string; pluginName: string | null }
	| {
			kind: "set-plugin-settings";
			name: string;
			patch: Record<string, UiPluginSettingValue | undefined>;
	  }
	/** 整体替换（迁移回写用：patch 只能合并，删不掉被 drop 的键） */
	| {
			kind: "replace-plugin-settings";
			name: string;
			settings: Record<string, UiPluginSettingValue> | undefined;
			settingsVersion?: number;
	  };

/**
 * 持久化配置意图：旧字段读取与新值计算都在 JsonStore 的 update 队列内。
 * 失败不吞（log 后重抛）：IPC handler 已 await 落盘才返回/推 config 事件，
 * reject 后 renderer 收到失败、不再误推成功事件。
 */
export async function updateUiPluginsConfig(command: UiPluginsConfigCommand): Promise<void> {
	try {
		await configStore().update((draft) => {
			const config = normalize(draft ?? {});
			switch (command.kind) {
				case "set-enabled":
					config.enabled = command.enabled;
					break;
				case "set-plugin-enabled": {
					const current = config.plugins[command.name];
					// 保留 settings / settingsVersion：启用停用是"跑不跑代码"，不是"要不要留配置"
					config.plugins[command.name] = {
						...current,
						enabled: command.enabled,
						trusted: command.enabled || (current?.trusted ?? false),
					};
					break;
				}
				case "assign-slot":
					if (command.pluginName === null) delete config.assignments[command.slot];
					else config.assignments[command.slot] = command.pluginName;
					break;
				case "set-plugin-settings": {
					const current = config.plugins[command.name];
					// 未启用/未信任的插件同样允许写（信任门管的是"跑代码"，不是"存配置"）
					const base = current ?? { enabled: false, trusted: false };
					const merged = applySettingsPatch(base.settings, command.patch);
					if (!merged.ok) throw new Error(`插件配置写入被拒绝：${merged.reason}`);
					const next = { ...base };
					if (merged.value) next.settings = merged.value;
					else delete next.settings;
					config.plugins[command.name] = next;
					break;
				}
				case "replace-plugin-settings": {
					const base = config.plugins[command.name] ?? { enabled: false, trusted: false };
					const next = { ...base };
					if (command.settings) next.settings = command.settings;
					else delete next.settings;
					const version = normalizeSettingsVersion(command.settingsVersion);
					if (version > 0) next.settingsVersion = version;
					else delete next.settingsVersion;
					config.plugins[command.name] = next;
					break;
				}
			}
			return config;
		});
	} catch (err) {
		log.error("ui-plugins config save failed", err);
		throw err;
	}
}
