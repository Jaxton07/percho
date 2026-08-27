import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextManagerMode } from "@percho/shared";
import { JsonStore } from "../../json-store";
import { createLogger } from "../../log";
import { DEFAULT_EVAP_CONFIG, type EvapConfig } from "./types";

const log = createLogger("context-evaporation-config");

/**
 * 蒸发配置链路：单一决策 key + 单一写者原子写 + 派生读。
 *
 * - `contextEvaporation`（本模块拥有）：对象整体容错读，缺字段补默认值（spec §9 定稿）
 * - 上下文管理二态：contextEvaporation.enabled === false → off；否则（true 或缺 key）→ evaporation（默认蒸发）
 * - 遗留 `acpCompressionEnabled` 键读侧忽略（不再参与派生），写侧 `writeContextManagerMode` 顺带 delete 收敛
 *
 * 解析容错（JSONC 容忍解析、2s TTL 缓存、fail-soft）沿袭既有实现。
 */

const CACHE_TTL_MS = 2000;

const evapCache = new Map<string, { value: unknown; expires: number }>();
const modeCache = new Map<string, { value: ContextManagerMode; expires: number }>();

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
	try {
		return parseSettings(readFileSync(join(agentDir, "settings.json"), "utf8")) ?? {};
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("settings.json 读取失败，按缺省处理", {
				file: join(agentDir, "settings.json"),
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return {};
	}
}

// ---------- readEvapConfig ----------

function numOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 读取蒸发配置（`contextEvaporation` 键；2s TTL 缓存——context 钩子每轮调用）。
 * 对象整体容错：缺 key / 非法值逐字段回退默认值（spec §9 方案 B 定稿）。
 */
export function readEvapConfig(agentDir: string): EvapConfig {
	const now = Date.now();
	const cached = evapCache.get(agentDir);
	if (cached && cached.expires > now) return cached.value as EvapConfig;

	const raw = readSettingsRaw(agentDir);
	const src =
		raw.contextEvaporation &&
		typeof raw.contextEvaporation === "object" &&
		!Array.isArray(raw.contextEvaporation)
			? (raw.contextEvaporation as Record<string, unknown>)
			: {};
	const tiersSrc =
		src.tiers && typeof src.tiers === "object" && !Array.isArray(src.tiers)
			? (src.tiers as Record<string, unknown>)
			: {};
	const tiers = {
		snip: numOr(tiersSrc.snip, DEFAULT_EVAP_CONFIG.tiers.snip),
		prune: numOr(tiersSrc.prune, DEFAULT_EVAP_CONFIG.tiers.prune),
		summarize: numOr(tiersSrc.summarize, DEFAULT_EVAP_CONFIG.tiers.summarize),
	};
	const tier2Scope: "all" | "gt4k" =
		src.tier2Scope === "gt4k" ? "gt4k" : src.tier2Scope === "all" ? "all" : DEFAULT_EVAP_CONFIG.tier2Scope;
	const protectedTools = Array.isArray(src.protectedTools)
		? src.protectedTools.filter((t): t is string => typeof t === "string")
		: DEFAULT_EVAP_CONFIG.protectedTools;
	const value: EvapConfig = {
		tiers,
		budgetTokens: numOr(src.budgetTokens, DEFAULT_EVAP_CONFIG.budgetTokens),
		protectionTokens: numOr(src.protectionTokens, DEFAULT_EVAP_CONFIG.protectionTokens),
		headLines: numOr(src.headLines, DEFAULT_EVAP_CONFIG.headLines),
		tailLines: numOr(src.tailLines, DEFAULT_EVAP_CONFIG.tailLines),
		headTailThreshold: numOr(src.headTailThreshold, DEFAULT_EVAP_CONFIG.headTailThreshold),
		tier2Scope,
		trimAssistantText: src.trimAssistantText === true,
		protectedTools,
	};
	evapCache.set(agentDir, { value, expires: now + CACHE_TTL_MS });
	return value;
}

// ---------- readContextManagerMode ----------

/**
 * 派生读：`"evaporation" | "off"`（二态，默认蒸发）。
 * - contextEvaporation.enabled === false → off；否则（true 或缺 key）→ evaporation
 * - 遗留 `acpCompressionEnabled` 键不再参与派生（读侧忽略；写侧收敛，见 writeContextManagerMode）
 */
export function readContextManagerMode(agentDir: string): ContextManagerMode {
	const now = Date.now();
	const cached = modeCache.get(agentDir);
	if (cached && cached.expires > now) return cached.value;

	const raw = readSettingsRaw(agentDir);
	const evapSrc =
		raw.contextEvaporation &&
		typeof raw.contextEvaporation === "object" &&
		!Array.isArray(raw.contextEvaporation)
			? (raw.contextEvaporation as Record<string, unknown>)
			: {};
	const mode: ContextManagerMode = evapSrc.enabled === false ? "off" : "evaporation";
	modeCache.set(agentDir, { value: mode, expires: now + CACHE_TTL_MS });
	return mode;
}

// ---------- writeContextManagerMode ----------

/**
 * 写模式（设置 UI 唯一写入口）：一次 JsonStore updateSync 原子写——
 * - `mode="evaporation"` → contextEvaporation.enabled=true
 * - `mode="off"` → contextEvaporation.enabled=false
 * 只动 `contextEvaporation.enabled`（其数值子键保留），settings.json 其余键不动；
 * 顺带 delete 遗留 `acpCompressionEnabled` 键（幂等收敛，spec D5）。
 * 写后清本模块读缓存，下一轮 context 钩子即见新值。
 * 损坏拒写（JsonStoreCorruptedError 上抛，renderer 需要知道保存失败）。
 */
export function writeContextManagerMode(agentDir: string, mode: ContextManagerMode): void {
	const store = new JsonStore<Record<string, unknown>>({
		path: join(agentDir, "settings.json"),
		defaultValue: () => ({}),
		parse: (raw) => {
			const parsed = parseSettings(raw);
			if (!parsed) throw new Error("settings.json 解析失败（非对象）");
			return parsed;
		},
	});
	store.updateSync((existing) => {
		const evap =
			existing.contextEvaporation &&
			typeof existing.contextEvaporation === "object" &&
			!Array.isArray(existing.contextEvaporation)
				? { ...(existing.contextEvaporation as Record<string, unknown>) }
				: {};
		evap.enabled = mode === "evaporation";
		existing.contextEvaporation = evap;
		delete existing.acpCompressionEnabled;
	});
	clearEvapConfigCache(agentDir);
}

/** 仅测试用：清缓存 */
export function clearEvapConfigCache(agentDir?: string): void {
	if (agentDir) {
		evapCache.delete(agentDir);
		modeCache.delete(agentDir);
	} else {
		evapCache.clear();
		modeCache.clear();
	}
}
