import type { UiPluginSettingsMigration, UiPluginSettingsSchema, UiPluginSettingValue } from "@percho/shared";

/**
 * 插件自有配置的有界校验。
 *
 * 为什么在 main 侧做而不是信任 renderer：ui-plugins.json 是宿主配置文件，插件代码（第三方）
 * 通过 usePluginSettings 间接写入，必须在落盘前把形状钉死。
 * - 只接受 JSON 标量：对象/数组会引入深层结构与原型污染面，一律丢弃；
 * - 只读自有属性（hasOwn），避免 `__proto__` 之类的继承键被当成配置；
 * - 键名、单值长度、键数、总大小四层上限，防把配置文件写爆。
 */

/** 单键名最大长度（同时须匹配 SETTING_KEY_RE） */
export const SETTING_KEY_MAX_LEN = 64;
/** 键名字符集：只允许字母数字与 . _ -（避免怪字符污染 JSON 键与日志） */
export const SETTING_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** 单个字符串值最大长度（字符） */
export const SETTING_VALUE_MAX_LEN = 4096;
/** 一个插件最多多少个键 */
export const SETTING_MAX_KEYS = 64;
/** 一个插件的设置序列化后总大小上限（字节） */
export const SETTING_MAX_JSON = 32 * 1024;

/** 是否合法的插件配置值（JSON 标量；number 需有限） */
export function isSettingValue(value: unknown): value is UiPluginSettingValue {
	if (value === null) return true;
	switch (typeof value) {
		case "string":
			return value.length <= SETTING_VALUE_MAX_LEN;
		case "number":
			return Number.isFinite(value);
		case "boolean":
			return true;
		default:
			return false;
	}
}

function isSettingKey(key: string): boolean {
	return SETTING_KEY_RE.test(key);
}

/**
 * 校验并归一化一份设置表：丢弃非法键值，条数超限时按 key 排序截断（保证确定性，不做"随机保留"）。
 * 返回 undefined 表示"没有设置"（宿主据此不落 settings 字段）。
 */
export function sanitizePluginSettings(raw: unknown): Record<string, UiPluginSettingValue> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const entries: [string, UiPluginSettingValue][] = [];
	for (const key of Object.keys(raw as Record<string, unknown>)) {
		if (!isSettingKey(key)) continue;
		const value = (raw as Record<string, unknown>)[key];
		if (!isSettingValue(value)) continue;
		entries.push([key, value]);
	}
	if (entries.length === 0) return undefined;
	entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const out: Record<string, UiPluginSettingValue> = {};
	for (const [key, value] of entries.slice(0, SETTING_MAX_KEYS)) out[key] = value;
	// 截断后仍可能超总大小（64 × 4KB）：继续丢，直到塞进上限（至少留一个键，便于插件看日志发现问题）
	while (Object.keys(out).length > 1 && JSON.stringify(out).length > SETTING_MAX_JSON) {
		const last = Object.keys(out).at(-1);
		if (last === undefined) break;
		delete out[last];
	}
	return out;
}

/** 单次迁移最多跑几步（防 manifest 里写的版本号把循环拉长） */
export const SETTINGS_MIGRATION_MAX_STEPS = 32;

/** settingsVersion 合法值：非负整数，其它一律当 0（从未迁移） */
export function normalizeSettingsVersion(raw: unknown): number {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1_000_000 ? raw : 0;
}

/** 迁移结果；applied=false 时 value 就是原样（调用方不必回写） */
export interface SettingsMigrationResult {
	value: Record<string, UiPluginSettingValue> | undefined;
	version: number;
	applied: boolean;
}

/**
 * 把已存配置从 fromVersion 逐级升到 schema.version。
 *
 * 缺省版本（settingsVersion 字段不存在）= 1：声明式版本化之前的配置就是"第一版"，
 * 插件的第一个迁移步骤是 migrations["2"]。这样老配置也能被迁到，且新装的空配置跑一遍无副作用。
 *
 * 只做声明式的数据变换（改名/删键/补默认值），不执行插件代码 —— 版本升级不该有"跑一段迁移函数"
 * 这种不可静态检查的口子。缺某一步就停在那一步并把版本一起停住：宁可下次继续，也不要标成已迁移。
 */
export function migratePluginSettings(
	stored: Record<string, UiPluginSettingValue> | undefined,
	fromVersion: unknown,
	schema: UiPluginSettingsSchema | undefined,
): SettingsMigrationResult {
	const current =
		fromVersion === undefined || fromVersion === null ? 1 : normalizeSettingsVersion(fromVersion);
	const target = normalizeSettingsVersion(schema?.version);
	if (!schema || target <= current) return { value: stored, version: current, applied: false };
	let version = current;
	let value: Record<string, UiPluginSettingValue> = { ...(stored ?? {}) };
	let steps = 0;
	while (version < target && steps < SETTINGS_MIGRATION_MAX_STEPS) {
		// key = 目标版本：migrations["2"] 表示"把 v1 升到 v2"（从 0 起逐级跑，旧的无版本配置也会被迁到）
		const step = schema.migrations?.[String(version + 1)];
		if (!step) break;
		value = applyMigrationStep(value, step);
		version += 1;
		steps += 1;
	}
	return { value: sanitizePluginSettings(value) ?? {}, version, applied: steps > 0 };
}

/** 单个迁移步骤：先 rename（不覆盖已有新键）→ set（只补缺键）→ drop（最后删，避免删掉刚改名的别名） */
function applyMigrationStep(
	src: Record<string, UiPluginSettingValue>,
	step: UiPluginSettingsMigration,
): Record<string, UiPluginSettingValue> {
	const out: Record<string, UiPluginSettingValue> = { ...src };
	for (const [from, to] of Object.entries(step.rename ?? {})) {
		const value = out[from];
		if (value === undefined || to in out) continue;
		out[to] = value;
		delete out[from];
	}
	for (const [key, value] of Object.entries(step.set ?? {})) {
		if (!(key in out)) out[key] = value;
	}
	for (const key of step.drop ?? []) delete out[key];
	return out;
}

/** patch 合并结果 */
export type SettingsPatchResult =
	| { ok: true; value: Record<string, UiPluginSettingValue> | undefined }
	| { ok: false; reason: string };

/**
 * 应用一次 patch：`undefined` 值 = 删除该键；非法键名/非法值整条 patch 拒绝（不是静默丢弃，
 * 否则插件会以为写进去了）。合并后再走一遍 sanitize，保证与读到的配置同形。
 */
export function applySettingsPatch(
	current: Record<string, UiPluginSettingValue> | undefined,
	patch: unknown,
): SettingsPatchResult {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		return { ok: false, reason: "patch 必须是对象" };
	}
	const next: Record<string, UiPluginSettingValue> = { ...(current ?? {}) };
	for (const key of Object.keys(patch as Record<string, unknown>)) {
		if (!isSettingKey(key)) return { ok: false, reason: `键名非法：${key}` };
		const value = (patch as Record<string, unknown>)[key];
		if (value === undefined) {
			delete next[key];
			continue;
		}
		if (!isSettingValue(value)) return { ok: false, reason: `值非法：${key}` };
		next[key] = value;
	}
	// 越界直接拒绝，不截断：静默丢键会让插件以为自己写进去了（读路径的截断只用于修复损坏文件）
	const keys = Object.keys(next);
	if (keys.length > SETTING_MAX_KEYS) {
		return { ok: false, reason: `设置项超过 ${SETTING_MAX_KEYS} 个` };
	}
	if (JSON.stringify(next).length > SETTING_MAX_JSON) {
		return { ok: false, reason: "设置总大小超限" };
	}
	return { ok: true, value: sanitizePluginSettings(next) };
}
