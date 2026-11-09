/**
 * 上下文压缩的两层开关（设置 UI 用）。
 *
 * 两层都在 `~/.percho/agent/settings.json`，缺省都是开：
 * - `compaction.enabled`：SDK 原生自动压缩（`shouldCompact()` 在 false 时直接不压）。SDK 自己的持久化是
 *   读-改-写（只套改动字段），因此我们写这个键不会被它覆盖，反之它的 `reserveTokens` 等兄弟键也不被我丢。
 * - `compactionGuard.enabled`：Percho 压缩护栏（阈值触发 + 摘要输入有界化）。护栏不做缓存、在请求边界
 *   读最新配置，因此写完即生效，不需要重载会话。
 *
 * 纪律：写侧一律走 `JsonStore`（原子写 + 损坏拒写），不手写 `writeFileSync`；读侧 JSONC 容错、fail-soft
 * （读失败按默认开处理，绝不让设置读取影响会话）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompressionConfig } from "@percho/shared";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";
import { DEFAULT_COMPACTION_GUARD_CONFIG } from "../tools/compaction-guard/types";

const log = createLogger("compression-settings");

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 剥行/块注释与尾随逗号（JSONC 容错，沿袭 compaction-guard / channel-watch config 写法） */
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
			if (isRecord(parsed)) return parsed;
			return null;
		} catch {
			// 试下一个候选
		}
	}
	return null;
}

/** 读侧 fail-soft：缺文件按默认，其他 IO 错误记 warn 后按默认，绝不上抛 */
function readSettings(agentDir: string): Record<string, unknown> {
	const file = join(agentDir, "settings.json");
	try {
		return parseSettings(readFileSync(file, "utf8")) ?? {};
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("压缩开关读取失败，按默认（两层都开）处理", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return {};
	}
}

export function readCompressionConfig(agentDir: string): CompressionConfig {
	const settings = readSettings(agentDir);
	const compaction = isRecord(settings.compaction) ? settings.compaction : {};
	const guard = isRecord(settings.compactionGuard) ? settings.compactionGuard : {};
	return {
		// 缺 key = 开（两层都是「只有显式 false 才关」）
		sdkAutoEnabled: compaction.enabled !== false,
		guardEnabled: guard.enabled !== false,
		thresholdPct:
			typeof guard.thresholdPct === "number"
				? guard.thresholdPct
				: DEFAULT_COMPACTION_GUARD_CONFIG.thresholdPct,
	};
}

function settingsStore(agentDir: string): JsonStore<Record<string, unknown>> {
	return new JsonStore<Record<string, unknown>>({
		path: join(agentDir, "settings.json"),
		defaultValue: () => ({}),
		parse: (raw) => {
			const parsed = parseSettings(raw);
			if (!parsed) throw new Error("settings.json 解析失败（非对象）");
			return parsed;
		},
	});
}

/** 只改 `compaction.enabled`，保留同段兄弟键（`reserveTokens`/`keepRecentTokens`/模型覆盖等） */
export function writeSdkAutoCompression(agentDir: string, enabled: boolean): void {
	settingsStore(agentDir).updateSync((existing) => {
		const compaction = isRecord(existing.compaction) ? existing.compaction : {};
		compaction.enabled = enabled;
		existing.compaction = compaction;
	});
	log.info("SDK 自动压缩开关已保存", enabled);
}

/** 只改 `compactionGuard.enabled`，保留阈值/冷却等调参键 */
export function writeCompactionGuardEnabled(agentDir: string, enabled: boolean): void {
	settingsStore(agentDir).updateSync((existing) => {
		const guard = isRecord(existing.compactionGuard) ? existing.compactionGuard : {};
		guard.enabled = enabled;
		existing.compactionGuard = guard;
	});
	log.info("压缩护栏开关已保存", enabled);
}
