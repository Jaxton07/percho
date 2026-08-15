import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { collectBashCandidates } from "./bash-chain";

/**
 * 逐工具权限规则求值 + 模式匹配 + 模式键建议（opencode 风格
 * allow/ask/deny × 通配模式，后命中生效；bash 走命令链最严段）。
 */

export type PermissionAction = "allow" | "ask" | "deny";

/** 单工具规则：直接动作，或「模式 → 动作」表（键序即评估序，后命中生效） */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;

export interface PermissionRules {
	/** 全局兜底动作（未列出的工具） */
	"*"?: PermissionAction;
	[toolName: string]: PermissionRule | undefined;
}

export interface PermissionOutside {
	/** read/ls/show_image 越界动作（默认 allow，与 bash cat 现状对齐；拦读不换安全只损效率） */
	read: PermissionAction;
	/** edit/write 越界动作（默认 ask） */
	write: PermissionAction;
}

const ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

/** 通配匹配：* 任意字符序列，? 单字符，其余字面；整串匹配，大小写敏感 */
export function matchPattern(pattern: string, text: string): boolean {
	const regex = pattern
		.split("")
		.map((ch) => {
			if (ch === "*") return ".*";
			if (ch === "?") return ".";
			return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${regex}$`).test(text);
}

/** 动作严格度：deny > ask > allow（命令链任一段取最严，危险命令无法藏在链里） */
const ACTION_PRIORITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * 单段求值：默认值 → "*" 全局动作 → 工具动作 → 工具模式表（后命中覆盖）。
 * matchText 为 null（自定义工具无结构化匹配文本）时只吃工具名级动作与全局兜底。
 */
function evaluateSingle(
	rules: PermissionRules,
	toolName: string,
	matchText: string | null,
	fallback: PermissionAction,
): PermissionAction {
	let action = fallback;
	const globalRule = rules["*"];
	if (globalRule && ACTIONS.has(globalRule)) {
		action = globalRule;
	}
	const toolRule = rules[toolName];
	if (!toolRule) return action;
	if (ACTIONS.has(toolRule as string)) {
		return toolRule as PermissionAction;
	}
	if (typeof toolRule === "object" && matchText !== null) {
		for (const [pattern, patternAction] of Object.entries(toolRule)) {
			if (ACTIONS.has(patternAction) && matchPattern(pattern, matchText)) {
				action = patternAction;
			}
		}
	}
	return action;
}

/**
 * bash 命令链求值：所有候选（见 collectBashCandidates）分别求值，动作取最严
 * （deny > ask > allow）——`cd x && ls && rm -rf y`、`echo $(rm -rf y)` 均无法绕过。
 * segment 返回命中最终动作的候选（供弹窗标题定位危险命令；无分隔符时即整串）。
 */
export function evaluateBashCommand(
	rules: PermissionRules,
	command: string,
	fallback: PermissionAction = "ask",
): { action: PermissionAction; segment: string } {
	// 从最松（allow）起步，候选结果各自已含 fallback，取最严者
	let action: PermissionAction = "allow";
	let segment = command;
	for (const candidate of collectBashCandidates(command)) {
		const a = evaluateSingle(rules, "bash", candidate, fallback);
		if (ACTION_PRIORITY[a] > ACTION_PRIORITY[action]) {
			action = a;
			segment = candidate;
		}
	}
	return { action, segment };
}

/**
 * 规则求值：bash 走命令链切段（evaluateBashCommand），其余工具单段求值。
 */
export function evaluateRules(
	rules: PermissionRules,
	toolName: string,
	matchText: string | null,
	fallback: PermissionAction = "ask",
): PermissionAction {
	if (toolName === "bash" && matchText !== null) {
		return evaluateBashCommand(rules, matchText, fallback).action;
	}
	return evaluateSingle(rules, toolName, matchText, fallback);
}

/** 从 tool_call 输入提取匹配文本；无法提取（自定义工具）返回 null */
export function matchTextFor(toolName: string, input: Record<string, unknown>): string | null {
	const value = (() => {
		switch (toolName) {
			case "bash":
				return input.command;
			case "read":
			case "edit":
			case "write":
			case "ls":
				return input.path;
			case "show_image": {
				// 多路径参数取首个做边界抽查（数组整体逃逸是已知边角）
				const paths = input.paths;
				return Array.isArray(paths) ? paths[0] : input.path;
			}
			case "grep":
			case "find":
				return input.pattern;
			default:
				return undefined;
		}
	})();
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** 目录粒度过宽的守卫：/、home、home 祖先下的直接子文件用精确路径，不做目录模式 */
function tooBroadDir(dir: string, home: string): boolean {
	return dir === "/" || dir === home || home.startsWith(dir + sep) || dir === dirname(home);
}

/**
 * 路径工具的 allowAlways 模式键：父目录前缀（`edit: /dir/*`）。
 * 精确文件粒度太细——换一个文件又弹；目录粒度在用户点过「总是允许」后是合理授权面。
 * 过宽目录（/、home、home 祖先）退回精确路径，绝不因记忆键放大到整个家目录。
 */
function pathToolPattern(toolName: string, path: string, home: string): string {
	const dir = dirname(path);
	return tooBroadDir(dir, home) ? `${toolName}: ${path}` : `${toolName}: ${dir}${sep}*`;
}

/** matchText 是文件路径的工具（路径目录化记忆；与 permission-extension 的边界检查工具集对应） */
const PATH_PATTERN_TOOLS = new Set(["read", "edit", "write", "ls", "show_image"]);

/**
 * ask 弹窗的模式键（PermissionGate 会话内记忆 + workspaces.json 项目级持久化）。
 * bash 取前两 token（第二 token 须为子命令形态如 `git push` 或 flag 形态如 `rm -rf`），
 * flag 规整让 allowAlways 粒度是「rm -rf*」而非「rm*」；路径工具用父目录前缀（pathToolPattern）。
 */
export function suggestPattern(toolName: string, input: Record<string, unknown>): string {
	const matchText = matchTextFor(toolName, input);
	if (toolName === "bash" && matchText) {
		const tokens = matchText.trim().split(/\s+/);
		const first = tokens[0] ?? "";
		const second = tokens[1] ?? "";
		if (first && /^(?:[a-zA-Z][a-zA-Z0-9-]*|-[a-zA-Z][a-zA-Z0-9-]*)$/.test(second)) {
			return `bash: ${first} ${second}*`;
		}
		return `bash: ${first}*`;
	}
	if (matchText) {
		if (PATH_PATTERN_TOOLS.has(toolName)) {
			return pathToolPattern(toolName, matchText, homedir());
		}
		return `${toolName}: ${matchText}`;
	}
	return toolName;
}

/**
 * 项目级记忆匹配（workspaces.json 的 allowed[] 模式键 vs 本次工具调用）。
 * 键格式同 suggestPattern："bash: git push*" / "write: /dir/*" / "my_tool"（无匹配文本）。
 * bash 与命令链求值同构：任一切段/替换/包装候选命中即算命中（`cd x && git push` 命中 `bash: git push*`）。
 */
export function patternMatchesToolCall(pattern: string, toolName: string, matchText: string | null): boolean {
	const idx = pattern.indexOf(": ");
	const pTool = idx > 0 ? pattern.slice(0, idx) : pattern;
	const pText = idx > 0 ? pattern.slice(idx + 2) : null;
	if (pTool !== toolName) return false;
	if (pText === null) return true;
	if (matchText === null) return false;
	if (toolName === "bash") {
		return collectBashCandidates(matchText).some((c) => matchPattern(pText, c));
	}
	return matchPattern(pText, matchText);
}
