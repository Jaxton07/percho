import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	rules: PermissionRules;
}

const ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

/**
 * 默认配置：宽松 + 高危兜底（coding agent 效率优先）。
 * 只读工具/编辑/自定义工具默认 allow；bash 默认 allow，枚举的高危命令 ask。
 */
export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
	enabled: true,
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
		},
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

/**
 * 规则求值：默认值 → "*" 全局动作 → 工具动作 → 工具模式表（后命中覆盖）。
 * matchText 为 null（自定义工具无结构化匹配文本）时只吃工具名级动作与全局兜底。
 */
export function evaluateRules(
	rules: PermissionRules,
	toolName: string,
	matchText: string | null,
	fallback: PermissionAction = "ask",
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
			case "grep":
			case "find":
				return input.pattern;
			default:
				return undefined;
		}
	})();
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * ask 弹窗的模式键（PermissionGate 的 allowAlways 按 title 记忆 = 会话白名单）。
 * bash 取前两 token（第二 token 须为子命令形态），其余工具用精确路径/工具名。
 */
export function suggestPattern(toolName: string, input: Record<string, unknown>): string {
	const matchText = matchTextFor(toolName, input);
	if (toolName === "bash" && matchText) {
		const tokens = matchText.trim().split(/\s+/);
		const first = tokens[0] ?? "";
		const second = tokens[1] ?? "";
		if (first && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(second)) {
			return `bash: ${first} ${second}*`;
		}
		return `bash: ${first}*`;
	}
	if (matchText) {
		return `${toolName}: ${matchText}`;
	}
	return toolName;
}

/** 配置规则与默认值按工具粒度合并：文件里的单工具规则整体替换默认的同名规则 */
export function mergeWithDefaults(config: Partial<PermissionConfig>): PermissionConfig {
	return {
		enabled: config.enabled ?? true,
		rules: { ...DEFAULT_PERMISSION_CONFIG.rules, ...(config.rules ?? {}) },
	};
}

function isValidRule(rule: unknown): rule is PermissionRule {
	if (typeof rule === "string") return ACTIONS.has(rule);
	if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return false;
	return Object.values(rule).every((v) => typeof v === "string" && ACTIONS.has(v));
}

function parseConfig(raw: unknown): Partial<PermissionConfig> {
	if (typeof raw !== "object" || raw === null) return {};
	const input = raw as { enabled?: unknown; rules?: unknown };
	const result: Partial<PermissionConfig> = {};
	if (typeof input.enabled === "boolean") result.enabled = input.enabled;
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
