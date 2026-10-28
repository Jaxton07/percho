import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../log";
import { type CompactionGuardConfig, DEFAULT_COMPACTION_GUARD_CONFIG } from "./types";

const log = createLogger("compaction-guard-config");

/**
 * 压缩护栏配置链路：用户级 settings.json 的 `compactionGuard` 段（**内部调参面，不进设置页**，spec D7）。
 *
 * - 缺 key / 非法值 → 逐字段回退默认值（默认值即产品行为）；
 * - 读失败（除 ENOENT）→ 记 warn 并按默认值继续（fail-soft，绝不影响会话）；
 * - 不做 TTL 缓存：请求边界和摘要输入钩子读取最新配置，不需要在保存/reload 后补内存覆盖。
 * - JSONC 容错解析（剥注释/尾随逗号）沿袭 `context-evaporation/config.ts`、`channel-watch/config.ts` 既有写法。
 */

/** 剥行/块注释与尾随逗号（JSONC 容错语义） */
function stripJsonC(raw: string): string {
	return raw
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/,\s*([}\]])/g, "$1");
}

function parseSettings(raw: string): Record<string, unknown> | null {
	for (const candidate of [raw, stripJsonC(raw)]) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return null;
		} catch {
			// 试下一个候选
		}
	}
	return null;
}

function readSettingsRaw(agentDir: string): Record<string, unknown> {
	const file = join(agentDir, "settings.json");
	try {
		return parseSettings(readFileSync(file, "utf8")) ?? {};
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("settings.json 读取失败，compactionGuard 按默认值处理", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return {};
	}
}

const DEFAULTS = DEFAULT_COMPACTION_GUARD_CONFIG;

/** 有限数 + 区间校验，任一不满足即回退默认（越界不夹紧：脏值一律按默认，行为可预测） */
function numIn(value: unknown, min: number, max: number, fallback: number, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (integer && !Number.isInteger(value)) return fallback;
	if (value < min || value > max) return fallback;
	return value;
}

export function readCompactionGuardConfig(agentDir: string): CompactionGuardConfig {
	const raw = readSettingsRaw(agentDir);
	const section = raw.compactionGuard;
	const src =
		section && typeof section === "object" && !Array.isArray(section)
			? (section as Record<string, unknown>)
			: {};

	return {
		// 缺 key = 默认开；只有显式 false 才关（逃生舱）
		enabled: src.enabled !== false,
		// 触发线：>0 且 ≤100 的百分数
		thresholdPct: numIn(src.thresholdPct, Number.EPSILON, 100, DEFAULTS.thresholdPct),
		// 上限比例：>0 且 ≤1
		hardCapRatio: numIn(src.hardCapRatio, Number.EPSILON, 1, DEFAULTS.hardCapRatio),
		// 保护区轮数：≥0 整数（0 = 不保护）
		protectTurns: numIn(src.protectTurns, 0, Number.MAX_SAFE_INTEGER, DEFAULTS.protectTurns, true),
		// 单条 toolResult 上限：≥1 整数
		toolResultChars: numIn(src.toolResultChars, 1, Number.MAX_SAFE_INTEGER, DEFAULTS.toolResultChars, true),
		// 冷却：≥0（0 = 不冷却）
		cooldownMs: numIn(src.cooldownMs, 0, Number.MAX_SAFE_INTEGER, DEFAULTS.cooldownMs),
	};
}
