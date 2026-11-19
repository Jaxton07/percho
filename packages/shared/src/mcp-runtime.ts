import type { McpConfigListResult, McpRuntimeInventory, McpServerView } from "./mcp";

/** 配置列表与订阅共用同一投影：undefined 只在唯一候选时自动选，null 明确不选。 */
export function projectMcpRuntime(
	config: McpConfigListResult,
	runtime: McpRuntimeInventory,
	instanceId?: string | null,
): McpConfigListResult {
	const candidates = runtime.instances.filter((instance) => instance.cwd === config.contextCwd);
	const selected =
		instanceId === undefined
			? candidates.length === 1
				? candidates[0]
				: undefined
			: candidates.find((instance) => instance.instanceId === instanceId);
	const withStatus = (server: McpServerView): McpServerView => {
		const configuredEnabled = server.configuredEnabled ?? server.enabled;
		const path = server.source === "user" ? config.globalPath : config.projectPath;
		const live = selected?.available
			? selected.servers.find(
					(status) => status.name === server.name && (status.override ?? status.source) === path,
				)
			: undefined;
		const overridden =
			server.source === "user" &&
			(selected?.available
				? selected.servers.some(
						(status) =>
							status.name === server.name && (status.override ?? status.source) === config.projectPath,
					)
				: config.project.some(
						(project) =>
							project.name === server.name && (project.overridesGlobal ?? config.errors.length === 0),
					));
		return {
			...server,
			configuredEnabled,
			enabled: live?.state ? live.state !== "disabled" : configuredEnabled,
			state: overridden
				? "overridden"
				: (live?.state ??
					(!configuredEnabled ? "disabled" : candidates.length === 0 ? "not-started" : "unknown")),
			tools: live?.tools ?? [],
			error: live?.error,
			needsAuth: live?.state === "needs-auth" || undefined,
			authUrl: live?.authUrl,
		};
	};
	return {
		...config,
		runtime,
		selectedInstanceId: selected?.instanceId,
		runtimeErrors: selected?.errors ?? [],
		notice: selected?.notice,
		global: config.global.map(withStatus),
		project: config.project.map(withStatus),
	};
}
