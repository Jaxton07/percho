import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./log";
import {
	createPermissionConfigLoader,
	evaluateRules,
	matchTextFor,
	suggestPattern,
} from "./permission-rules";

const log = createLogger("permission-gate");

/**
 * 内置权限门控扩展：只用 pi 公开扩展 API（tool_call 钩子 + ctx.ui.confirm），
 * 与用户可自行安装的权限扩展能力完全等同——可作为用户替代品的参考实现。
 * 规则配置 ~/.pi/agent/permissions.json（mtime 检查，修改即时生效）；
 * enabled=false 时整体放行（用户换用自己的扩展时关闭本扩展）。
 */
export function makePermissionGateExtension(agentDir: string): InlineExtension {
	return {
		name: "permission-gate",
		factory: (pi) => {
			const loadConfig = createPermissionConfigLoader(agentDir);
			pi.on("tool_call", async (event, ctx) => {
				const config = loadConfig();
				if (!config.enabled) return;
				const input = (event.input ?? {}) as Record<string, unknown>;
				const matchText = matchTextFor(event.toolName, input);
				const action = evaluateRules(config.rules, event.toolName, matchText);
				if (action === "allow") return;
				if (action === "deny") {
					log.info("tool blocked by rule", event.toolName, { matchText });
					return {
						block: true,
						reason: `Blocked by permission rule (${event.toolName}). The user can change this in permissions.json.`,
					};
				}
				const title = suggestPattern(event.toolName, input);
				const detail = matchText ?? JSON.stringify(input).slice(0, 500);
				let allowed = false;
				try {
					allowed = await ctx.ui.confirm(title, detail);
				} catch (err) {
					log.warn("confirm failed, blocking tool call", event.toolName, err);
				}
				if (allowed) return;
				log.info("tool blocked by user", event.toolName, { matchText });
				return {
					block: true,
					reason: `User denied this ${event.toolName} call (${title}). Do not retry the same action; ask the user or find another approach.`,
				};
			});
		},
	};
}
