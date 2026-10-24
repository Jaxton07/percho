// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	applySettingsPatch,
	isSettingValue,
	migratePluginSettings,
	normalizeSettingsVersion,
	SETTING_KEY_MAX_LEN,
	SETTING_MAX_KEYS,
	SETTING_VALUE_MAX_LEN,
	sanitizePluginSettings,
} from "./settings";

/** 插件配置的有界校验：落盘前把形状钉死，插件的错不该写进宿主配置 */

describe("isSettingValue", () => {
	it("接受 JSON 标量，拒绝对象/数组/函数/NaN/Infinity", () => {
		expect(isSettingValue("x")).toBe(true);
		expect(isSettingValue(0)).toBe(true);
		expect(isSettingValue(false)).toBe(true);
		expect(isSettingValue(null)).toBe(true);
		expect(isSettingValue({})).toBe(false);
		expect(isSettingValue([])).toBe(false);
		expect(isSettingValue(() => 1)).toBe(false);
		expect(isSettingValue(Number.NaN)).toBe(false);
		expect(isSettingValue(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isSettingValue(undefined)).toBe(false);
	});

	it("超长字符串不算合法值", () => {
		expect(isSettingValue("a".repeat(SETTING_VALUE_MAX_LEN))).toBe(true);
		expect(isSettingValue("a".repeat(SETTING_VALUE_MAX_LEN + 1))).toBe(false);
	});
});

describe("sanitizePluginSettings", () => {
	it("丢弃非法键名与非法值，没有合法项时返回 undefined", () => {
		expect(sanitizePluginSettings(undefined)).toBeUndefined();
		expect(sanitizePluginSettings([])).toBeUndefined();
		expect(sanitizePluginSettings({ __proto__: { polluted: true } })).toBeUndefined();
		expect(sanitizePluginSettings({ "bad key": 1 })).toBeUndefined();
		const out = sanitizePluginSettings({ ok: true, "bad key": 1, nested: { a: 1 } });
		expect(out).toEqual({ ok: true });
	});

	it("键名长度上限与键数上限生效，且结果按 key 排序（确定性）", () => {
		const tooLong = "k".repeat(SETTING_KEY_MAX_LEN + 1);
		expect(sanitizePluginSettings({ [tooLong]: 1 })).toBeUndefined();

		const many: Record<string, number> = {};
		for (let i = 0; i < SETTING_MAX_KEYS + 10; i++) many[`k${String(i).padStart(3, "0")}`] = i;
		const out = sanitizePluginSettings(many);
		expect(Object.keys(out ?? {})).toHaveLength(SETTING_MAX_KEYS);
		expect(Object.keys(out ?? {})[0]).toBe("k000");
	});

	it("原型链上的键不会被当成配置", () => {
		const out = sanitizePluginSettings({ own: 1 });
		expect(Object.keys(out ?? {})).toEqual(["own"]);
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
	});
});

describe("applySettingsPatch", () => {
	it("undefined 值 = 删除该键（patch 语义）", () => {
		const res = applySettingsPatch({ a: 1, b: 2 }, { b: undefined });
		expect(res).toEqual({ ok: true, value: { a: 1 } });
	});

	it("删空后返回 undefined（宿主据此不落 settings 字段）", () => {
		expect(applySettingsPatch({ a: 1 }, { a: undefined })).toEqual({ ok: true, value: undefined });
	});

	it("非法键名/非法值整条拒绝，而不是静默丢弃（插件要知道自己没写进去）", () => {
		expect(applySettingsPatch(undefined, { "bad key": 1 })).toMatchObject({ ok: false });
		expect(applySettingsPatch(undefined, { a: { deep: 1 } })).toMatchObject({ ok: false });
		expect(applySettingsPatch(undefined, "nope")).toMatchObject({ ok: false });
	});

	it("合并既有值后仍走一遍校验（总大小超限被拒）", () => {
		const big = "a".repeat(SETTING_VALUE_MAX_LEN);
		const patch: Record<string, string> = {};
		for (let i = 0; i < 12; i++) patch[`k${i}`] = big; // 12 × 4KB ≈ 48KB > 32KB 上限
		const res = applySettingsPatch(undefined, patch);
		expect(res).toMatchObject({ ok: false });
		if (!res.ok) expect(res.reason).toContain("总大小");
	});
});

/** 声明式迁移：只做数据结构变换，不跑插件代码 */
describe("migratePluginSettings", () => {
	const schema = {
		version: 3,
		migrations: {
			"1": { rename: { oldName: "prefix" } },
			"2": { set: { interval: 15 }, drop: ["legacyFlag"] },
			"3": { set: { theme: "plain" } },
		},
		fields: {},
	};

	it("从 0 逐级升到 version，改名/补默认/删键都生效", () => {
		const res = migratePluginSettings({ oldName: "bw", legacyFlag: true }, 0, schema);
		expect(res.applied).toBe(true);
		expect(res.version).toBe(3);
		expect(res.value).toEqual({ prefix: "bw", interval: 15, theme: "plain" });
	});

	it("已是最新版本时什么都不做（value 原样返回）", () => {
		const stored = { prefix: "x" };
		const res = migratePluginSettings(stored, 3, schema);
		expect(res.applied).toBe(false);
		expect(res.value).toBe(stored);
	});

	it("缺中间步骤就停在那一级（不标成已迁移，下次还能继续）", () => {
		const res = migratePluginSettings({ oldName: "bw" }, 0, {
			version: 3,
			migrations: { "1": { rename: { oldName: "prefix" } } },
			fields: {},
		});
		expect(res.version).toBe(1);
		expect(res.value).toEqual({ prefix: "bw" });
	});

	it("不覆盖用户已设置的新键（只补缺键）", () => {
		const res = migratePluginSettings({ prefix: "mine", interval: 30 }, 0, schema);
		expect(res.value).toMatchObject({ prefix: "mine", interval: 30 });
	});

	it("缺省版本按 1 处理（声明式版本化之前的老配置也要能被迁到）", () => {
		const res = migratePluginSettings({ oldPrefix: "bw" }, undefined, {
			version: 2,
			migrations: { "2": { rename: { oldPrefix: "prefix" } } },
			fields: {},
		});
		expect(res).toMatchObject({ applied: true, version: 2 });
		expect(res.value).toEqual({ prefix: "bw" });
	});

	it("没有 settingsSchema 或版本号不合法时不动配置", () => {
		expect(migratePluginSettings({ a: 1 }, 0, undefined)).toMatchObject({ applied: false });
		expect(migratePluginSettings({ a: 1 }, "2", { version: 5, fields: {} })).toMatchObject({
			applied: false,
			version: 0,
		});
		expect(normalizeSettingsVersion(Number.NaN)).toBe(0);
		expect(normalizeSettingsVersion(-1)).toBe(0);
		expect(normalizeSettingsVersion(7)).toBe(7);
	});
});
