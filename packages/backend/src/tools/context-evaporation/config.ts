import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextManagerMode } from "@percho/shared";
import { JsonStore } from "../../json-store";
import { createLogger } from "../../log";
import { clearAcpEnabledCache } from "../acp-context";
import { DEFAULT_EVAP_CONFIG, type EvapConfig } from "./types";

const log = createLogger("context-evaporation-config");

/**
 * 蒸发配置链路（arch §3）：物理双 key + 单一写者原子双写 + 派生读。
 *
 * - `contextEvaporation`（本模块拥有）：对象整体容错读，缺字段补默认值（spec §9 定稿）
 * - `acpCompressionEnabled`（ACP 拥有，本模块**只读不改代码**）：缺 key/异常 = 开（ACP 缺省语义）
 * - 互斥不靠两个 checkbox 自觉：写侧唯一入口 `writeContextManagerMode` 一次原子双写；
 *   读侧 `readContextManagerMode` 派生——双开冲突时 ACP 优先（保守现状偏向）+ warn
 *
 * 解析容错与 acp-context/config.ts 同款：JSONC 容忍解析、2s TTL 缓存、fail-soft。
 */

const CACHE_TTL_MS = 2000;

const evapCache = new Map<string, { value: unknown; expires: number }>();
const modeCache = new Map<string, { value: ContextManagerMode; expires: number }>();

/** 剥行/块注释与尾随逗号（与 acp config 同款 JSONC 语义） */
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
 * 派生读：`"acp" | "evaporation" | "off"`。
 * - evapOn = contextEvaporation.enabled === true；acpOn = acpCompressionEnabled !== false（ACP 缺省开）
 * - 双开冲突（手改文件）→ ACP 优先 + warn（蒸发是实验方）
 * - P4 默认值翻转只改这里的「全无 key」缺省（一个常量的事）
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
	const evapOn = evapSrc.enabled === true;
	const acpOn = raw.acpCompressionEnabled !== false;
	let mode: ContextManagerMode;
	if (evapOn && acpOn) {
		log.warn("配置冲突：蒸发与 ACP 同时开启，按 ACP 处理（请从设置页重新选择一次以收敛）");
		mode = "acp";
	} else if (evapOn) {
		mode = "evaporation";
	} else {
		mode = acpOn ? "acp" : "off";
	}
	modeCache.set(agentDir, { value: mode, expires: now + CACHE_TTL_MS });
	return mode;
}

// ---------- writeContextManagerMode ----------

/**
 * 写模式（设置 UI 唯一写入口）：一次 JsonStore updateSync 原子双写——
 * - `mode="evaporation"` → contextEvaporation.enabled=true 且 acpCompressionEnabled=false
 * - `mode="acp"` → contextEvaporation.enabled=false 且 acpCompressionEnabled=true
 * - `mode="off"` → 两者都 false
 * 只动这两个 key（`contextEvaporation` 的数值子键保留），settings.json 其余键不动。
 * 写后清两侧读缓存（本模块 + ACP 的 TTL 缓存），下一轮 context 钩子即见新值。
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
		existing.acpCompressionEnabled = mode === "acp";
	});
	clearEvapConfigCache(agentDir);
	clearAcpEnabledCache();
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
