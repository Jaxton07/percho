import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createLogger } from "./log";

const log = createLogger("permission-rules");

export type PermissionAction = "allow" | "ask" | "deny";

/** 单工具规则：直接动作，或「模式 → 动作」表（键序即评估序，后命中生效） */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;

export interface PermissionRules {
	/** 全局兜底动作（未列出的工具） */
	"*"?: PermissionAction;
	[toolName: string]: PermissionRule | undefined;
}

export interface PermissionConfig {
	enabled: boolean;
	/** 路径工具落在全部工作区根之外时的动作（读写分离：观察默认放行，变更默认确认） */
	outside: PermissionOutside;
	rules: PermissionRules;
}

export interface PermissionOutside {
	/** read/ls/show_image 越界动作（默认 allow，与 bash cat 现状对齐；拦读不换安全只损效率） */
	read: PermissionAction;
	/** edit/write 越界动作（默认 ask） */
	write: PermissionAction;
}

const ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

/** agent 自身权限/信任/凭证配置的文件名（默认规则自保护：改动这些文件必须确认） */
const PROTECTED_FILES = ["permissions.json", "workspaces.json", "auth.json", "trust.json"] as const;

/**
 * 默认配置：宽松 + 高危兜底（coding agent 效率优先）。
 * 只读工具/编辑/自定义工具默认 allow；bash 默认 allow，枚举的高危命令 ask；
 * 读写分离：路径工具越界时读放行、写确认；agent 自身权限/信任/凭证配置改动必确认。
 */
export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
	enabled: true,
	outside: { read: "allow", write: "ask" },
	rules: {
		"*": "allow",
		bash: {
			"*": "allow",
			"sudo *": "ask",
			"rm -rf *": "ask",
			"rm -fr *": "ask",
			"rm -r *": "ask",
			"rm -r -f *": "ask",
			"rm -f -r *": "ask",
			"rm --recursive *": "ask",
			"mkfs*": "ask",
			"dd *": "ask",
			"shred *": "ask",
			"git push --force*": "ask",
			"git push -f*": "ask",
			"git reset --hard*": "ask",
			"git clean -f*": "ask",
			"git clean --force*": "ask",
			"curl * | sh*": "ask",
			"curl * | bash*": "ask",
			"wget * | sh*": "ask",
			"wget * | bash*": "ask",
			// 自保护：任何触及权限/信任/凭证配置的命令（含重定向写入）必确认
			"*permissions.json*": "ask",
			"*workspaces.json*": "ask",
			"*auth.json*": "ask",
			"*trust.json*": "ask",
		},
		// 同自保护：edit/write 改权限/信任/凭证文件必确认（路径模式尾缀匹配）
		...Object.fromEntries(
			["edit", "write"].map((tool) => [
				tool,
				Object.fromEntries(PROTECTED_FILES.map((file) => [`*${file}`, "ask"] as const)),
			]),
		),
	},
};

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
 * bash 命令链切段：引号感知扫描，&& || & | ; 与换行仅在引号外分隔，去空段。
 * 引号内不执行分隔符（`echo "a && rm -rf x"` 不误切）；`2>&1` 的 `>&`/`<&` 不算分隔。
 */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaped = false;
	const push = () => {
		const trimmed = current.trim();
		if (trimmed.length > 0) segments.push(trimmed);
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			current += ch;
			quote = ch;
			continue;
		}
		if (ch === "&" || ch === "|") {
			const prev = current.trimEnd();
			// 重定向复制 fd（2>&1、<&0）不是命令分隔
			if (ch === "&" && (prev.endsWith(">") || prev.endsWith("<"))) {
				current += ch;
				continue;
			}
			if (command[i + 1] === ch) i++;
			push();
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "\r") {
			push();
			continue;
		}
		current += ch;
	}
	push();
	return segments;
}

/**
 * 提取顶层命令替换内容（$( ) 与反引号；单引号内不执行故跳过）。
 * 双引号内的替换仍执行，照常提取。嵌套由 collectBashCandidates 递归处理。
 */
export function extractSubstitutions(text: string): string[] {
	const found: string[] = [];
	let quote: string | null = null;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "'" && quote === null) {
			quote = "'";
			continue;
		}
		if (ch === '"') {
			quote = quote === '"' ? null : '"';
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			if (end < 0) break;
			found.push(text.slice(i + 1, end));
			i = end;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			let depth = 1;
			let innerQuote: string | null = null;
			let innerEscaped = false;
			let j = i + 2;
			for (; j < text.length && depth > 0; j++) {
				const c = text[j];
				if (innerEscaped) {
					innerEscaped = false;
					continue;
				}
				if (c === "\\" && innerQuote !== "'") {
					innerEscaped = true;
					continue;
				}
				if (innerQuote) {
					if (c === innerQuote) innerQuote = null;
					continue;
				}
				if (c === "'" || c === '"') {
					innerQuote = c;
					continue;
				}
				if (c === "(") depth++;
				if (c === ")") depth--;
			}
			if (depth === 0) {
				found.push(text.slice(i + 2, j - 1));
				i = j - 1;
			} else {
				break;
			}
		}
	}
	return found;
}

const WRAPPER_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);

/** 去外层配对引号；有尾随内容时截取引号内部分（`'cmd' extra` → `cmd`） */
function extractQuoted(text: string): string {
	const q = text[0];
	if (q !== "'" && q !== '"') return text;
	const end = text.indexOf(q, 1);
	return end > 0 ? text.slice(1, end) : text.slice(1);
}

/**
 * 提取包装执行的真实命令：`sh|bash|... -c <cmd>`（含 -lc 等合并 flag）与 `eval <cmd>`。
 * 无法提取返回 null。xargs / find -exec / python -c 等其余包装不在覆盖范围（模式方案天花板）。
 */
export function extractShellExecArg(segment: string): string | null {
	const tokens = segment.trim().split(/\s+/);
	if (tokens[0] === "eval" && tokens.length > 1) {
		return extractQuoted(tokens.slice(1).join(" ").trim());
	}
	if (!WRAPPER_SHELLS.has(tokens[0] ?? "")) return null;
	let i = 1;
	while (i < tokens.length) {
		const flag = tokens[i];
		if (!flag || !/^-[a-zA-Z]+$/.test(flag)) break;
		if (flag.includes("c")) {
			const rest = tokens
				.slice(i + 1)
				.join(" ")
				.trim();
			return rest.length > 0 ? extractQuoted(rest) : null;
		}
		i++;
	}
	return null;
}

/**
 * 收集 bash 求值候选：整串（兼容 "curl * | sh*" 整串模式）+ 各段 +
 * 命令替换内容与 -c/eval 包装参数（递归，嵌套替换/包装逐层剥开）。
 */
function collectBashCandidates(command: string): string[] {
	const candidates = new Set<string>();
	const visited = new Set<string>();
	const walk = (text: string) => {
		if (visited.has(text)) return;
		visited.add(text);
		candidates.add(text);
		for (const segment of splitShellSegments(text)) {
			candidates.add(segment);
			const execArg = extractShellExecArg(segment);
			if (execArg) {
				candidates.add(execArg);
				walk(execArg);
			}
		}
		for (const sub of extractSubstitutions(text)) {
			candidates.add(sub);
			walk(sub);
		}
	};
	walk(command);
	return [...candidates];
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

/** 配置规则与默认值按工具粒度合并：文件里的单工具规则整体替换默认的同名规则；outside 字段级合并 */
export function mergeWithDefaults(config: Partial<PermissionConfig>): PermissionConfig {
	return {
		enabled: config.enabled ?? true,
		outside: {
			read: config.outside?.read ?? DEFAULT_PERMISSION_CONFIG.outside.read,
			write: config.outside?.write ?? DEFAULT_PERMISSION_CONFIG.outside.write,
		},
		rules: { ...DEFAULT_PERMISSION_CONFIG.rules, ...(config.rules ?? {}) },
	};
}

function isValidRule(rule: unknown): rule is PermissionRule {
	if (typeof rule === "string") return ACTIONS.has(rule);
	if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return false;
	return Object.values(rule).every((v) => typeof v === "string" && ACTIONS.has(v));
}

function parseOutside(raw: unknown): PermissionOutside | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const input = raw as { read?: unknown; write?: unknown };
	const result: Partial<PermissionOutside> = {};
	if (typeof input.read === "string" && ACTIONS.has(input.read)) {
		result.read = input.read as PermissionAction;
	}
	if (typeof input.write === "string" && ACTIONS.has(input.write)) {
		result.write = input.write as PermissionAction;
	}
	return result.read || result.write ? (result as PermissionOutside) : undefined;
}

function parseConfig(raw: unknown): Partial<PermissionConfig> {
	if (typeof raw !== "object" || raw === null) return {};
	const input = raw as { enabled?: unknown; outside?: unknown; rules?: unknown };
	const result: Partial<PermissionConfig> = {};
	if (typeof input.enabled === "boolean") result.enabled = input.enabled;
	result.outside = parseOutside(input.outside);
	if (typeof input.rules === "object" && input.rules !== null && !Array.isArray(input.rules)) {
		const rules: PermissionRules = {};
		for (const [tool, rule] of Object.entries(input.rules)) {
			if (tool === "*") {
				if (typeof rule === "string" && ACTIONS.has(rule)) rules["*"] = rule as PermissionAction;
				continue;
			}
			if (isValidRule(rule)) rules[tool] = rule;
		}
		result.rules = rules;
	}
	return result;
}

export function permissionConfigPath(agentDir: string): string {
	return join(agentDir, "permissions.json");
}

/** 读取权限配置；文件不存在或非法时回退默认配置 */
export function loadPermissionConfig(agentDir: string): PermissionConfig {
	const path = permissionConfigPath(agentDir);
	if (!existsSync(path)) return mergeWithDefaults({});
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return mergeWithDefaults(parseConfig(raw));
	} catch (err) {
		log.warn("permissions.json 解析失败，使用默认配置", path, err);
		return mergeWithDefaults({});
	}
}

/** 写 enabled 开关（保留现有 rules；无文件时只写 enabled，rules 走默认） */
export function setPermissionEnabled(agentDir: string, enabled: boolean): void {
	const path = permissionConfigPath(agentDir);
	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8"));
			if (typeof raw === "object" && raw !== null) existing = raw as Record<string, unknown>;
		} catch (err) {
			log.warn("permissions.json 读取失败，将重写为仅含 enabled", path, err);
		}
	}
	writeFileSync(path, `${JSON.stringify({ ...existing, enabled }, null, 2)}\n`, "utf-8");
}

/** mtime 缓存的配置读取：扩展在每次 tool_call 前调用，开关/规则修改即时生效 */
export function createPermissionConfigLoader(agentDir: string): () => PermissionConfig {
	let cached: { mtimeMs: number | null; config: PermissionConfig } | undefined;
	return () => {
		const path = permissionConfigPath(agentDir);
		let mtimeMs: number | null = null;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			mtimeMs = null;
		}
		if (cached && cached.mtimeMs === mtimeMs) return cached.config;
		const config = loadPermissionConfig(agentDir);
		cached = { mtimeMs, config };
		return config;
	};
}
