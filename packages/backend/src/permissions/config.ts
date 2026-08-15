import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../log";
import type { PermissionAction, PermissionOutside, PermissionRule, PermissionRules } from "./pattern";

const log = createLogger("permission-rules");

/**
 * 权限配置读写：~/.pi/agent/permissions.json（enabled + outside + rules），
 * 文件规则按工具粒度替换默认；非法内容回退默认配置。
 */

export interface PermissionConfig {
	enabled: boolean;
	/** 路径工具落在全部工作区根之外时的动作（读写分离：观察默认放行，变更默认确认） */
	outside: PermissionOutside;
	rules: PermissionRules;
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
