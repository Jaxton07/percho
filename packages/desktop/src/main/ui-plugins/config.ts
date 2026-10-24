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
				...(p.workbenchTrusted === true ? { workbenchTrusted: true } : {}),
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

export type UiPluginsConfigCommand =
	| { kind: "trust-workbench"; names: string[] }
	| { kind: "set-enabled"; enabled: boolean }
	| { kind: "set-plugin-enabled"; name: string; enabled: boolean }
	| { kind: "assign-slot"; slot: string; pluginName: string | null };

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
				case "trust-workbench":
					for (const name of command.names)
						config.plugins[name] = {
							enabled: config.plugins[name]?.enabled ?? false,
							trusted: true,
							workbenchTrusted: true,
						};
					break;
				case "set-enabled":
					config.enabled = command.enabled;
					break;
				case "set-plugin-enabled":
					config.plugins[command.name] = {
						enabled: command.enabled,
						trusted: command.enabled || (config.plugins[command.name]?.trusted ?? false),
						...(config.plugins[command.name]?.workbenchTrusted ? { workbenchTrusted: true } : {}),
					};
					break;
				case "assign-slot":
					if (command.pluginName === null) delete config.assignments[command.slot];
					else config.assignments[command.slot] = command.pluginName;
					break;
			}
			return config;
		});
	} catch (err) {
		log.error("ui-plugins config save failed", err);
		throw err;
	}
}
