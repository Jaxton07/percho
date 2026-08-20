import type { AgentSession, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { isSubagentToolName } from "@percho/shared";

export interface ShadowedSubagentExtension {
	extensionPath: string;
	tools: string[];
}

export interface SubagentMutexResult {
	shadowed: ShadowedSubagentExtension[];
	disabledToolNames: string[];
}

function isSubagentFamily(name: string): boolean {
	// 同名 subagent 已由 customTools 覆盖语义接管（不能停用，会误伤内置）；只显式停用家族配套
	return name !== "subagent" && isSubagentToolName(name);
}

/** 内置 subagent 后写覆盖同名扩展；其余 subagent_* 工具显式从 active set 移除。 */
export function applySubagentMutex(
	session: Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName">,
	extensionsResult: LoadExtensionsResult,
	preferBuiltin: boolean,
): SubagentMutexResult {
	if (!preferBuiltin) return { shadowed: [], disabledToolNames: [] };
	const shadowed: ShadowedSubagentExtension[] = [];
	const disabled = new Set<string>();
	for (const extension of extensionsResult.extensions) {
		const tools = [...extension.tools.keys()].filter((name) => name === "subagent" || isSubagentFamily(name));
		if (tools.length === 0) continue;
		shadowed.push({ extensionPath: extension.path, tools });
		for (const name of tools) if (isSubagentFamily(name)) disabled.add(name);
	}
	if (disabled.size > 0) {
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => !disabled.has(name)));
	}
	return { shadowed, disabledToolNames: [...disabled] };
}
