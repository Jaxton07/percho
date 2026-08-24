import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonStore } from "../../json-store";
import { createLogger } from "../../log";

const log = createLogger("acp-config");

/**
 * ACP 开关（T1 → P2）：用户级 settings.json 的 `acpCompressionEnabled`（**默认开**，P2 起
 * 随 app 默认启用；显式 false 才关）。设置页「通用」面板经 IPC 读写（writeAcpEnabled）。
 *
 * 解析容错：settings.json 由 SDK SettingsManager 拥有，理论上是纯 JSON，但按
 * JSONC 容忍解析（先原样 JSON.parse，失败再剥注释重试）；任何异常按默认开处理，
 * 绝不抛——开关读取失败不应该影响会话创建（扩展全链路 try/catch 降级，fail-soft）。
 */

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { value: boolean; expires: number }>();

/** 默认值：P2 起默认启用（缺 key / 读失败 / 非法值都按开；显式 false 才关） */
const ACP_DEFAULT_ENABLED = true;

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
	let value = ACP_DEFAULT_ENABLED;
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = parseSettings(raw);
		// 缺 key = 默认开；只有显式 false 才关
		value = parsed?.acpCompressionEnabled === false ? false : ACP_DEFAULT_ENABLED;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("acp 开关读取失败，按默认开处理", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		value = ACP_DEFAULT_ENABLED;
	}
	cache.set(agentDir, { value, expires: now + CACHE_TTL_MS });
	return value;
}

/** 仅测试用：清缓存 */
export function clearAcpEnabledCache(): void {
	cache.clear();
}

/**
 * 写 enabled 开关（设置 UI 用）：read-modify-write 保留 settings.json 其余键
 * （该文件由 SDK SettingsManager 拥有，只增改这一个 key）。原子写 + 损坏拒写
 * （JsonStoreCorruptedError 上抛，renderer 需要知道保存失败）；写后清读缓存，
 * 下一次读取立即见到新值。
 */
export function writeAcpEnabled(agentDir: string, enabled: boolean): void {
	const store = new JsonStore<Record<string, unknown>>({
		path: join(agentDir, "settings.json"),
		defaultValue: () => ({}),
		// parseSettings 容错返回 null；update 语义需要「损坏 = throw」才能拒写而不是拿 null 崩
		parse: (raw) => {
			const parsed = parseSettings(raw);
			if (!parsed) throw new Error("settings.json 解析失败（非对象）");
			return parsed;
		},
	});
	store.updateSync((existing) => {
		existing.acpCompressionEnabled = enabled;
	});
	clearAcpEnabledCache();
}
