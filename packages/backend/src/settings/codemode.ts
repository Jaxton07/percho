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

/** 无用户工具配置时补充只读辅助工具；保留显式选择，另应用 Code Mode 开关。 */
export function codemodeSessionOptions(settings: SettingsManager, agentDir: string) {
	const enabled = readCodemodeEnabled(agentDir);
	const defaults = settings.getDefaultTools();
	settings.applyOverrides({
		defaultTools: defaults
			? [...defaults.filter((name) => name !== "codemode"), ...(enabled ? ["codemode"] : [])]
			: ["+grep", "+find", "+ls", enabled ? "+codemode" : "-codemode"],
	});
	return { excludeTools: enabled ? undefined : ["codemode"] };
}
