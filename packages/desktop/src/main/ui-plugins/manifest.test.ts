// @vitest-environment node
import type { UiPluginContribution, UiPluginSettingsSchema } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { filterContributions, validateManifest } from "./manifest";

/** filterContributions 纯函数测试：坏 manifest 的 contributions 防御（B2 配套；随实现迁至 manifest.ts） */

describe("filterContributions", () => {
	it("非数组输入（undefined / 对象 / 字符串）→ 空数组", () => {
		expect(filterContributions(undefined)).toEqual([]);
		expect(filterContributions({} as unknown as UiPluginContribution[])).toEqual([]);
		expect(filterContributions("nope" as unknown as UiPluginContribution[])).toEqual([]);
	});

	it("剔除未知 region 条目", () => {
		const input: UiPluginContribution[] = [
			{ id: "a", region: "app.overlay", export: "Overlay" },
			{ id: "b", region: "future.region", export: "Future" },
		];
		expect(filterContributions(input)).toEqual([{ id: "a", region: "app.overlay", export: "Overlay" }]);
	});

	it("非 app.overlay 区域的 anchor 剥离，overlay 区域保留", () => {
		const input: UiPluginContribution[] = [
			{ id: "a", region: "app.overlay", export: "Overlay", anchor: "top-left" },
			{ id: "b", region: "chat.corner.top-right", export: "Corner", anchor: "top-right" },
		];
		expect(filterContributions(input)).toEqual([
			{ id: "a", region: "app.overlay", export: "Overlay", anchor: "top-left" },
			{ id: "b", region: "chat.corner.top-right", export: "Corner", anchor: undefined },
		]);
	});
});

describe("validateManifest · perchoUi 2 契约", () => {
	const base = { name: "demo", perchoUi: 2, main: "src/index.tsx", headless: true };

	it("接受 perchoUi 2，并校验 styles", () => {
		expect(validateManifest("demo", { ...base })).toBeNull();
		expect(validateManifest("demo", { ...base, styles: ["src/a.css", "src/b.css"] })).toBeNull();
		expect(validateManifest("demo", { ...base, styles: ["src/a.scss"] })).toContain("只接受 .css");
		expect(validateManifest("demo", { ...base, styles: ["../a.css"] })).toContain("路径非法");
		expect(validateManifest("demo", { ...base, styles: ["/etc/a.css"] })).toContain("路径非法");
		expect(
			validateManifest("demo", { ...base, styles: Array.from({ length: 9 }, (_, i) => `${i}.css`) }),
		).toContain("最多 8 个");
	});

	it("settingsSchema：字段类型/文案/select 选项都要合法", () => {
		const ok = {
			fields: {
				auto: { type: "boolean", label: { zh: "自动", en: "Auto" }, default: true },
				browser: { type: "string", label: "浏览器" },
				port: { type: "number", label: "端口", min: 1024, max: 65535 },
				profile: {
					type: "select",
					label: "配置",
					options: [{ value: "a", label: { zh: "甲", en: "A" } }],
				},
			},
		};
		expect(validateManifest("demo", { ...base, settingsSchema: ok as never })).toBeNull();
		expect(
			validateManifest("demo", {
				...base,
				settingsSchema: { fields: { a: { type: "date", label: "x" } } } as never,
			}),
		).toContain("type 非法");
		expect(
			validateManifest("demo", { ...base, settingsSchema: { fields: { a: { type: "string", label: "" } } } }),
		).toContain("label 非法");
		expect(
			validateManifest("demo", {
				...base,
				settingsSchema: { fields: { a: { type: "select", label: "x", options: [] } } },
			}),
		).toContain("options");
	});

	it("settings.panel 贡献的 layout / isolation 枚举校验", () => {
		const contributionBase = { id: "cfg", region: "settings.panel", export: "Cfg" };
		expect(
			validateManifest("demo", {
				...base,
				headless: undefined,
				contributions: [{ ...contributionBase, layout: "full", isolation: "shadow" }],
			}),
		).toBeNull();
		expect(
			validateManifest("demo", {
				...base,
				headless: undefined,
				contributions: [{ ...contributionBase, layout: "wide" as unknown as "full" }],
			}),
		).toContain("layout 非法");
		expect(
			validateManifest("demo", {
				...base,
				headless: undefined,
				contributions: [{ ...contributionBase, isolation: "iframe" as unknown as "shadow" }],
			}),
		).toContain("isolation 非法");
	});

	it("v1 插件声明 v2 字段不判 invalid，但 filterContributions 会把字段剥掉", () => {
		const m = {
			name: "demo",
			perchoUi: 1,
			main: "src/index.tsx",
			contributions: [
				{
					id: "cfg",
					region: "settings.panel",
					export: "Cfg",
					layout: "full" as const,
					isolation: "shadow" as const,
				},
			],
		};
		expect(validateManifest("demo", m)).toBeNull();
		const [c] = filterContributions(m.contributions, 1);
		expect(c?.layout).toBeUndefined();
		expect(c?.isolation).toBeUndefined();
		// perchoUi 2 则保留
		const [c2] = filterContributions(m.contributions, 2);
		expect(c2?.layout).toBe("full");
		expect(c2?.isolation).toBe("shadow");
	});
});

describe("validateManifest：settingsSchema.migrations", () => {
	const base = {
		name: "demo",
		perchoUi: 2,
		main: "src/index.tsx",
		contributions: [{ id: "a", region: "chat.corner.top-right", export: "A" }],
	};

	it("合法的迁移脚本通过", () => {
		expect(
			validateManifest("demo", {
				...base,
				settingsSchema: {
					version: 2,
					migrations: { "1": { rename: { a: "b" }, set: { c: 1 }, drop: ["d"] } },
					fields: { b: { type: "string", label: "B" } },
				},
			}),
		).toBeNull();
	});

	it("键不是版本号 / 动作形状不对 / 键名非法都判 invalid", () => {
		const withSchema = (migrations: unknown) =>
			validateManifest("demo", {
				...base,
				settingsSchema: {
					version: 2,
					migrations: migrations as UiPluginSettingsSchema["migrations"],
					fields: { b: { type: "string", label: "B" } },
				},
			});
		expect(withSchema({ v1: { set: { a: 1 } } })).toContain("版本号");
		expect(withSchema({ "1": { rename: [] } })).toContain("rename");
		expect(withSchema({ "1": { drop: [1] } })).toContain("删除键名");
		expect(withSchema({ "1": { set: { "bad key": 1 } } })).toContain("补写键名");
		expect(withSchema({ "1": { set: { a: { nested: 1 } } } })).toContain("补写值非法");
	});
});
