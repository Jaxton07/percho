import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonStore } from "../../json-store";
import { createLogger } from "../../log";

const log = createLogger("channel-watch-config");

/**
 * channel-watch 总开关（spec D7）：用户级 settings.json 的 `channelWatchEnabled`
 * （**默认开**——用户拍板默认启用）。设置页「通用」面板经 IPC 读写。
 *
 * 结构沿用 settings 配置链路既有模式：JSONC 容错解析 + 2s TTL 缓存 + fail-soft
 * （读失败按默认开，绝不影响会话创建）。
 */

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { value: boolean; expires: number }>();

const DEFAULT_ENABLED = true;

/** 剥行/块注释与尾随逗号（容错解析用） */
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

/** 读取 channel-watch 开关（带 2s TTL 缓存） */
export function readChannelWatchEnabled(agentDir: string): boolean {
	const file = join(agentDir, "settings.json");
	const now = Date.now();
	const cached = cache.get(agentDir);
	if (cached && cached.expires > now) return cached.value;
	let value = DEFAULT_ENABLED;
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = parseSettings(raw);
		// 缺 key = 默认开；只有显式 false 才关
		value = parsed?.channelWatchEnabled === false ? false : DEFAULT_ENABLED;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("channel-watch 开关读取失败，按默认开处理", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		value = DEFAULT_ENABLED;
	}
	cache.set(agentDir, { value: value, expires: now + CACHE_TTL_MS });
	return value;
}

/** 仅测试用：清缓存 */
export function clearChannelWatchEnabledCache(): void {
	cache.clear();
}

/**
 * 写 enabled 开关（设置 UI 用）：read-modify-write 保留 settings.json 其余键；
 * 原子写 + 损坏拒写（JsonStoreCorruptedError 上抛）；写后清读缓存。
 */
export function writeChannelWatchEnabled(agentDir: string, enabled: boolean): void {
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
		existing.channelWatchEnabled = enabled;
	});
	clearChannelWatchEnabledCache();
}
