import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../log";

const log = createLogger("acp-config");

/**
 * ACP 开关（T1）：用户级 settings.json 的 `acpCompressionEnabled`（默认 false，opt-in）。
 * P1 只做 backend 内部读取（不进设置页）；P2 进 SettingsService + 设置 UI。
 *
 * 解析容错：settings.json 由 SDK SettingsManager 拥有，理论上是纯 JSON，但按
 * JSONC 容忍解析（先原样 JSON.parse，失败再剥注释重试）；任何异常按关处理，绝不抛——
 * 开关读取失败不应该影响会话创建。
 */

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { value: boolean; expires: number }>();

/** 剥行/块注释与尾随逗号（容错解析用，与 models.json 的 JSONC 语义对齐） */
function stripJsonC(raw: string): string {
	return raw
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/,\s*([}\]])/g, "$1");
}

function parseSettings(raw: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		try {
			const parsed = JSON.parse(stripJsonC(raw)) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return null;
		} catch {
			return null;
		}
	}
}

/** 读取 ACP 开关（带 2s TTL 缓存：context 钩子每轮调用，避免每次 LLM 调用都读盘） */
export function readAcpEnabled(agentDir: string): boolean {
	const file = join(agentDir, "settings.json");
	const now = Date.now();
	const cached = cache.get(agentDir);
	if (cached && cached.expires > now) return cached.value;
	let value = false;
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = parseSettings(raw);
		value = parsed?.acpCompressionEnabled === true;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("acp 开关读取失败，按关处理", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		value = false;
	}
	cache.set(agentDir, { value, expires: now + CACHE_TTL_MS });
	return value;
}

/** 仅测试用：清缓存 */
export function clearAcpEnabledCache(): void {
	cache.clear();
}
