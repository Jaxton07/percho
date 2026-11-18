import { validateMcpServerConfig } from "@earendil-works/pi-coding-agent";
import { isMcpServerOverride, mcpNamespace } from "@earendil-works/pi-mcp";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate in SDK load order, retaining valid global entries for project overrides. */
export function validateMcpConfigs(global: unknown, project?: unknown): string[] {
	const errors: string[] = [];
	const effective = new Map<string, Record<string, unknown>>();
	for (const [scope, file] of [
		["global", global],
		["project", project],
	] as const) {
		if (file === undefined) continue;
		if (!record(file) || (file.mcpServers !== undefined && !record(file.mcpServers))) {
			errors.push(`${scope}: expected an object with an "mcpServers" object`);
			continue;
		}
		if (file.autoEnableCodemode !== undefined && typeof file.autoEnableCodemode !== "boolean") {
			errors.push(`${scope}: autoEnableCodemode must be a boolean`);
		}
		for (const [name, raw] of Object.entries((file.mcpServers ?? {}) as Record<string, unknown>)) {
			let value = raw;
			if (scope === "project" && record(raw) && isMcpServerOverride(raw)) {
				const base = effective.get(name);
				if (!base) {
					errors.push(`${scope}: server "${name}" needs "command" or "url", or a global server to override`);
					continue;
				}
				if (Object.keys(raw).some((key) => !["enabled", "exposure", "toolExposure"].includes(key))) {
					errors.push(`${scope}: server "${name}": an override can only set enabled, exposure, toolExposure`);
					continue;
				}
				value = { ...base, ...raw };
			}
			const result = validateMcpServerConfig(name, value);
			if (typeof result === "string") {
				errors.push(`${scope}: ${result}`);
				continue;
			}
			const clash = [...effective.keys()].find(
				(other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
			);
			if (clash) {
				errors.push(`${scope}: server "${name}" conflicts with "${clash}"`);
				continue;
			}
			if (
				scope === "project" &&
				"url" in result &&
				result.auth &&
				!(record(raw) && isMcpServerOverride(raw))
			) {
				errors.push(`${scope}: server "${name}": auth is only allowed in the global mcp.json`);
				continue;
			}
			effective.set(name, result as unknown as Record<string, unknown>);
		}
	}
	return errors;
}
