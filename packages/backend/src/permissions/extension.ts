import { isAbsolute, relative, resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../log";
import { createWorkspacesLoader, suggestRootCandidate } from "../project/workspace-store";
import {
	createPermissionConfigLoader,
	evaluateBashCommand,
	evaluateRules,
	matchTextFor,
	type PermissionAction,
	patternMatchesToolCall,
	suggestPattern,
} from ".";
import type { PermissionRequestMeta } from "./gate";
import { isRmSegment, isTemporaryPath, rmSegmentExempt } from "./tmp-zone";

const log = createLogger("permission-gate");

/** 观察类路径工具：越界默认放行（outside.read） */
const READ_TOOLS = new Set(["read", "ls", "show_image"]);
/** 变更类路径工具：越界默认确认（outside.write） */
const WRITE_TOOLS = new Set(["edit", "write"]);
const PATH_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);

/** 确认通道：携带 kind/suggestDir 元数据（PiBackend 桥到 PermissionGate.confirm） */
export type PermissionConfirm = (
	title: string,
	message: string,
	meta?: PermissionRequestMeta,
) => Promise<boolean>;

export interface PermissionGateOptions {
	/** 会话项目根：路径工具解析后落在全部工作区根之外时，读写分离处置 */
	projectRoot?: string;
	/** 直接确认通道（携带元数据）；缺省回退 ctx.ui.confirm（无元数据，弹窗无第四按钮） */
	confirm?: PermissionConfirm;
}

/**
 * 内置权限门控扩展：只用 pi 公开扩展 API（tool_call 钩子 + 确认通道）。
 * 求值顺序（设计见 .local/docs/design/phase2/permission-workspace.md、spec permission-tmp-zone）：
 *  ① 全局规则 permissions.json —— deny 直接 block
 *  ②' 系统临时区（os.tmpdir() ∪ /tmp，绝对地理概念，不依赖 projectRoot）：路径工具与
 *      rm 段目标全落临时区时按 outside.temporary 处置（默认 allow：agent 临时工作流免打断；
 *      可覆盖 ask，永不可覆盖 deny；仅改写 allow，不放松显式 ask）
 *  ② 路径边界（多根：projectRoot ∪ workspaces.json roots）—— 界外读放行/界外写确认（读写分离）
 *  ③ 项目记忆 workspaces.json allowed[]（allowAlways 持久化）—— 命中放行（可覆盖 ask，不可覆盖 deny）
 *  ④ ask → confirm（带 kind/suggestDir 元数据 → ApprovalDock 第四按钮「允许此目录」）
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
			const loadWorkspaces = createWorkspacesLoader(agentDir);
			pi.on("tool_call", async (event, ctx) => {
				const config = loadConfig();
				if (!config.enabled) return;
				const input = (event.input ?? {}) as Record<string, unknown>;
				const matchText = matchTextFor(event.toolName, input);
				// 相对路径 resolve 基准：projectRoot ?? ctx.cwd（皆缺时 tmp 豁免仅绝对路径可判，fail-safe）
				const base: string | undefined = projectRoot ?? ctx.cwd;
				// bash 单次求值同时拿到命中段（弹窗标题定位用）；段豁免钩子（②'）：rm 家族且
				// 全目标在临时区 → outside.temporary（默认 allow 跳过 rm 兜底；deny 永不被覆盖，在钩子内保证）
				const rmExempt = (segment: string): PermissionAction | null =>
					isRmSegment(segment) && rmSegmentExempt(segment, base) ? config.outside.temporary : null;
				const bashResult =
					event.toolName === "bash" && matchText
						? evaluateBashCommand(config.rules, matchText, "ask", rmExempt)
						: null;
				let action: PermissionAction = bashResult
					? bashResult.action
					: evaluateRules(config.rules, event.toolName, matchText);

				if (action === "deny") {
					log.info("tool blocked by rule", event.toolName, { matchText });
					return {
						block: true,
						reason: `Blocked by permission rule (${event.toolName}). The user can change this in permissions.json.`,
					};
				}

				// 路径边界（多根）+ 临时区（②'）：路径工具的匹配文本统一用 resolve 后的绝对路径
				// （记忆键/弹窗标题跨相对绝对写法稳定）
				const isPath = PATH_TOOLS.has(event.toolName);
				let patternText: string | null = matchText;
				let outside = false;
				if (isPath && matchText) {
					// 绝对路径直接用；相对按 base resolve；无 base 无从判定（保持原样，不进任一地理分支）
					const abs = isAbsolute(matchText)
						? matchText
						: base !== undefined
							? resolve(base, matchText)
							: null;
					// ②' 临时区优先：绝对地理概念（projectRoot 在临时区内也按 tmp 语义，spec §2 边界澄清）；
					// 沿用守卫——只在 action=allow 时改写（deny ① 已返回，显式 ask 规则不被放松）
					if (abs !== null && isTemporaryPath(abs)) {
						patternText = abs;
						if (action === "allow") {
							action = config.outside.temporary;
						}
					} else if (projectRoot && abs !== null) {
						const roots = [projectRoot, ...(loadWorkspaces().projects[projectRoot]?.roots ?? [])];
						const inside = roots.some((root) => {
							const rel = relative(root, abs);
							return !rel.startsWith("..") && !isAbsolute(rel);
						});
						patternText = abs;
						if (!inside) {
							outside = true;
							// 读写分离：界外读默认放行（拦读不换安全只损效率），界外写确认
							if (action === "allow") {
								action = READ_TOOLS.has(event.toolName) ? config.outside.read : config.outside.write;
							}
						}
					}
				}

				if (action === "allow") return;

				// 项目级记忆（allowAlways 持久化）：ask 可被覆盖，deny 已在上面返回；
				// 无匹配文本的自定义工具也可命中工具名级记忆（patternMatchesToolCall 对 null 宽容）
				if (projectRoot) {
					const allowed = loadWorkspaces().projects[projectRoot]?.allowed ?? [];
					if (allowed.some((pattern) => patternMatchesToolCall(pattern, event.toolName, patternText))) {
						return;
					}
				}

				// 标题 = 记忆模式键。bash 用命中危险段（allowAlways 按标题记忆 = 会话白名单，
				// 直接拿整串会导致 cd* 之类前缀入白名单，后续链式命令被误放行）
				const title = bashResult
					? suggestPattern("bash", { command: bashResult.segment })
					: isPath && patternText
						? suggestPattern(event.toolName, { path: patternText })
						: suggestPattern(event.toolName, input);
				const detail = matchText ?? JSON.stringify(input).slice(0, 500);
				const meta = {
					kind: isPath ? ("path" as const) : ("command" as const),
					// 「允许此目录」候选根：仅越界路径类有意义（git 根启发式，home 安全守卫在内）
					suggestDir: outside ? (suggestRootCandidate(patternText ?? "") ?? undefined) : undefined,
				};
				let allowed = false;
				try {
					const confirm = options?.confirm ?? ((t, m) => ctx.ui.confirm(t, m));
					allowed = await confirm(title, detail, meta);
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
