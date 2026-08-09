import { isAbsolute, relative, resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./log";
import {
	createPermissionConfigLoader,
	evaluateBashCommand,
	evaluateRules,
	matchTextFor,
	type PermissionAction,
	suggestPattern,
} from "./permission-rules";

const log = createLogger("permission-gate");

/** matchText 为文件路径的工具（项目边界检查对象；grep/find 的 matchText 是 pattern 不在列） */
const PATH_TOOLS = new Set(["read", "edit", "write", "ls"]);

export interface PermissionGateOptions {
	/** 会话项目根：带路径工具解析后落在根外时，规则结果为 allow 也提升为 ask */
	projectRoot?: string;
}

/**
 * 内置权限门控扩展：只用 pi 公开扩展 API（tool_call 钩子 + ctx.ui.confirm），
 * 与用户可自行安装的权限扩展能力完全等同——可作为用户替代品的参考实现。
 * 规则配置 ~/.pi/agent/permissions.json（mtime 检查，修改即时生效）；
 * enabled=false 时整体放行（用户换用自己的扩展时关闭本扩展）。
 * 边界检查只覆盖路径工具：bash 无法用路径模式约束（cd 任意跳），符号链接逃逸不在范围。
 */
export function makePermissionGateExtension(
	agentDir: string,
	options?: PermissionGateOptions,
): InlineExtension {
	const projectRoot = options?.projectRoot ? resolve(options.projectRoot) : null;
	return {
		name: "permission-gate",
		factory: (pi) => {
			const loadConfig = createPermissionConfigLoader(agentDir);
			pi.on("tool_call", async (event, ctx) => {
				const config = loadConfig();
				if (!config.enabled) return;
				const input = (event.input ?? {}) as Record<string, unknown>;
				const matchText = matchTextFor(event.toolName, input);
				// bash 单次求值同时拿到命中段（弹窗标题定位用）
				const bashResult =
					event.toolName === "bash" && matchText ? evaluateBashCommand(config.rules, matchText) : null;
				let action: PermissionAction = bashResult
					? bashResult.action
					: evaluateRules(config.rules, event.toolName, matchText);
				// 项目边界：路径工具落在根外时至少 ask（相对路径按 projectRoot resolve，可抓 ../../ 逃逸）
				if (action === "allow" && projectRoot && matchText && PATH_TOOLS.has(event.toolName)) {
					const abs = isAbsolute(matchText) ? matchText : resolve(projectRoot, matchText);
					const rel = relative(projectRoot, abs);
					if (rel.startsWith("..") || isAbsolute(rel)) {
						action = "ask";
					}
				}
				if (action === "allow") return;
				if (action === "deny") {
					log.info("tool blocked by rule", event.toolName, { matchText });
					return {
						block: true,
						reason: `Blocked by permission rule (${event.toolName}). The user can change this in permissions.json.`,
					};
				}
				// 标题用命令链中命中危险动作的段（allowAlways 按标题记忆 = 会话白名单，
				// 直接拿整串会导致 cd* 之类前缀入白名单，后续链式命令被误放行）
				const title = bashResult
					? suggestPattern("bash", { command: bashResult.segment })
					: suggestPattern(event.toolName, input);
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
