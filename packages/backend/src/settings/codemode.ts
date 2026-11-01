import { join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { JsonStore } from "../json-store";

function configStore(agentDir: string) {
	return new JsonStore<{ enabled?: boolean }>({
		path: join(agentDir, "codemode.json"),
		defaultValue: () => ({}),
		parse: (raw) => {
			const value = JSON.parse(raw);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Code Mode 配置必须是对象");
			return value;
		},
	});
}

export function readCodemodeEnabled(agentDir: string): boolean {
	return configStore(agentDir).readSync().enabled !== false;
}

export async function writeCodemodeEnabled(agentDir: string, enabled: boolean): Promise<void> {
	await configStore(agentDir).update((draft) => {
		draft.enabled = enabled;
	});
}

/** 只调整 Code Mode，保留 SDK 解析后的其他默认工具；关闭时阻止 MCP 再次激活。 */
export function codemodeSessionOptions(settings: SettingsManager, agentDir: string) {
	const enabled = readCodemodeEnabled(agentDir);
	const defaults = settings.getDefaultTools();
	settings.applyOverrides({
		defaultTools: defaults
			? [...defaults.filter((name) => name !== "codemode"), ...(enabled ? ["codemode"] : [])]
			: [enabled ? "+codemode" : "-codemode"],
	});
	return { excludeTools: enabled ? undefined : ["codemode"] };
}
