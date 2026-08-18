import type { UiPluginContribution, UiPluginManifest } from "@percho/shared";
import { KNOWN_UI_REGIONS, KNOWN_UI_SLOTS } from "@percho/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiPluginRegistry } from "./registry";
import { UI_REGIONS, UI_SLOTS } from "./slots";

/** 槽位名单与 shared 的 KNOWN_UI_SLOTS 一致（main 校验 manifest.slots 用同一份，两处不可漂移） */
it("UI_SLOTS 与 KNOWN_UI_SLOTS 对齐", () => {
	expect(Object.values(UI_SLOTS)).toEqual(KNOWN_UI_SLOTS);
});

/** 区域名单与 shared 的 KNOWN_UI_REGIONS 一致（main 校验 manifest.contributions 用同一份） */
it("UI_REGIONS 与 KNOWN_UI_REGIONS 对齐", () => {
	expect(Object.values(UI_REGIONS)).toEqual(KNOWN_UI_REGIONS);
});

function manifest(
	slots: Record<string, string>,
	name = "test-plugin",
	contributions?: UiPluginContribution[],
): UiPluginManifest {
	return { name, perchoUi: 1, main: "src/index.tsx", slots, contributions };
}

const noop = () => null;

beforeEach(() => {
	useUiPluginRegistry.setState({ overrides: {}, contributions: {}, crashCounts: {}, loadNonces: {} });
});

describe("ui plugin registry", () => {
	it("applyPlugin 注册声明的槽位 override", () => {
		const res = useUiPluginRegistry.getState().applyPlugin(
			manifest({
				[UI_SLOTS.ToolCallCard]: "ToolCallCard",
				[UI_SLOTS.SubagentCard]: "SubagentCard",
			}),
			{ ToolCallCard: noop, SubagentCard: noop },
			[UI_SLOTS.ToolCallCard, UI_SLOTS.SubagentCard],
		);
		expect(res).toEqual({ ok: true, missing: [] });
		const overrides = useUiPluginRegistry.getState().overrides;
		expect(overrides[UI_SLOTS.ToolCallCard]).toMatchObject({
			pluginName: "test-plugin",
			exportName: "ToolCallCard",
		});
		expect(overrides[UI_SLOTS.SubagentCard]).toMatchObject({ exportName: "SubagentCard" });
	});

	it("导出缺失/非函数 → 记入 missing 且不注册该槽位（其余槽位照常）", () => {
		const res = useUiPluginRegistry.getState().applyPlugin(
			manifest({
				[UI_SLOTS.ToolCallCard]: "ToolCallCard",
				[UI_SLOTS.SubagentCard]: "NotExported",
			}),
			{ ToolCallCard: noop, NotExported: "not-a-function" },
			[UI_SLOTS.ToolCallCard, UI_SLOTS.SubagentCard],
		);
		expect(res.ok).toBe(false);
		expect(res.missing).toEqual(["chat.subagent-card → NotExported"]);
		const overrides = useUiPluginRegistry.getState().overrides;
		expect(overrides[UI_SLOTS.SubagentCard]).toBeUndefined();
		expect(overrides[UI_SLOTS.ToolCallCard]).toBeDefined();
	});

	it("同一槽位后注册的插件顶掉前一个（一槽一 override）", () => {
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.TodoPanel]: "A" }), { A: noop }, [UI_SLOTS.TodoPanel]);
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.TodoPanel]: "B" }, "other"), { B: noop }, [UI_SLOTS.TodoPanel]);
		expect(useUiPluginRegistry.getState().overrides[UI_SLOTS.TodoPanel]).toMatchObject({
			pluginName: "other",
			exportName: "B",
		});
	});

	it("removePlugin 移除该插件全部 override、保留他人，崩溃计数清零", () => {
		useUiPluginRegistry
			.getState()
			.applyPlugin(
				manifest({ [UI_SLOTS.ToolCallCard]: "A", [UI_SLOTS.TodoPanel]: "A2" }),
				{ A: noop, A2: noop },
				[UI_SLOTS.ToolCallCard, UI_SLOTS.TodoPanel],
			);
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.SubagentCard]: "B" }, "other"), { B: noop }, [UI_SLOTS.SubagentCard]);
		useUiPluginRegistry.getState().reportCrash("test-plugin");
		useUiPluginRegistry.getState().removePlugin("test-plugin");
		const state = useUiPluginRegistry.getState();
		expect(state.overrides[UI_SLOTS.ToolCallCard]).toBeUndefined();
		expect(state.overrides[UI_SLOTS.TodoPanel]).toBeUndefined();
		expect(state.overrides[UI_SLOTS.SubagentCard]).toMatchObject({ pluginName: "other" });
		expect(state.crashCounts["test-plugin"]).toBeUndefined();
	});

	it("reportCrash 第 3 次达到自动禁用阈值", () => {
		const state = useUiPluginRegistry.getState();
		expect(state.reportCrash("p1")).toBe(false);
		expect(state.reportCrash("p1")).toBe(false);
		expect(state.reportCrash("p1")).toBe(true);
		expect(useUiPluginRegistry.getState().crashCounts.p1).toBe(3);
		// 阈值后继续累加仍返回 true
		expect(useUiPluginRegistry.getState().reportCrash("p1")).toBe(true);
	});

	it("崩溃计数按插件独立", () => {
		const state = useUiPluginRegistry.getState();
		state.reportCrash("p1");
		state.reportCrash("p2");
		state.reportCrash("p2");
		expect(useUiPluginRegistry.getState().crashCounts).toEqual({ p1: 1, p2: 2 });
	});

	it("无关操作不重建已注册 override（selector 稳定引用）", () => {
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.ToolCallCard]: "A" }), { A: noop }, [UI_SLOTS.ToolCallCard]);
		const before = useUiPluginRegistry.getState().overrides[UI_SLOTS.ToolCallCard];
		// 注册另一个插件的槽位、上报他人崩溃：都不该重建 A 的 override 对象
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.SubagentCard]: "B" }, "other"), { B: noop }, [UI_SLOTS.SubagentCard]);
		useUiPluginRegistry.getState().reportCrash("other");
		expect(useUiPluginRegistry.getState().overrides[UI_SLOTS.ToolCallCard]).toBe(before);
	});

	it("React.memo 包装的组件导出（对象）也能注册（spec §13 要求插件用 memo）", () => {
		// 模拟 esbuild 产物里 memo 的形态：$$typeof = Symbol.for("react.memo") 的对象
		const memoized = Object.assign(() => null, {
			$$typeof: Symbol.for("react.memo"),
		});
		const res = useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.ToolCallCard]: "ToolCallCard" }), { ToolCallCard: memoized }, [
				UI_SLOTS.ToolCallCard,
			]);
		expect(res).toEqual({ ok: true, missing: [] });
		expect(useUiPluginRegistry.getState().overrides[UI_SLOTS.ToolCallCard]).toMatchObject({
			exportName: "ToolCallCard",
		});
		// 普通对象（非 React 包装）仍拒绝
		const res2 = useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.TodoPanel]: "NotComp" }, "other"), { NotComp: { a: 1 } }, [
				UI_SLOTS.TodoPanel,
			]);
		expect(res2.ok).toBe(false);
		expect(res2.missing).toEqual(["chat.todo-panel → NotComp"]);
	});

	it("loadNonce：同名插件重复 apply 递增，removePlugin 不清除（错误边界 key 的数据源）", () => {
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.TodoPanel]: "A" }), { A: noop }, [UI_SLOTS.TodoPanel]);
		expect(useUiPluginRegistry.getState().loadNonces["test-plugin"]).toBe(1);
		// 热重载：remove → apply 同一插件（loader 的同步连调会被 React 批处理，边界不卸载，靠 nonce 换 key）
		// nonce 单调递增（removePlugin 不清除）：remove+apply 后 key 必变，崩溃边界实例重建、errored 归零
		useUiPluginRegistry.getState().removePlugin("test-plugin");
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.TodoPanel]: "A" }), { A: noop }, [UI_SLOTS.TodoPanel]);
		expect(useUiPluginRegistry.getState().loadNonces["test-plugin"]).toBe(2);
		// 不带 remove 的直接重载（apply 两次）：nonce 仍递增（新边界实例，errored 归零）
		useUiPluginRegistry
			.getState()
			.applyPlugin(manifest({ [UI_SLOTS.TodoPanel]: "A" }), { A: noop }, [UI_SLOTS.TodoPanel]);
		expect(useUiPluginRegistry.getState().loadNonces["test-plugin"]).toBe(3);
		// removePlugin 不再清除 nonce（单调递增防 key 复用；崩溃计数仍清除）
		useUiPluginRegistry.getState().removePlugin("test-plugin");
		expect(useUiPluginRegistry.getState().loadNonces["test-plugin"]).toBe(3);
		expect(useUiPluginRegistry.getState().crashCounts["test-plugin"]).toBeUndefined();
	});

	it("applyPlugin 注册区域贡献（含 anchor/title 透传），槽位与贡献并存", () => {
		const res = useUiPluginRegistry
			.getState()
			.applyPlugin(
				manifest({ [UI_SLOTS.TodoPanel]: "A" }, "test-plugin", [
					{ id: "pet", region: UI_REGIONS.AppOverlay, export: "Pet", anchor: "bottom-right", title: "桌宠" },
				]),
				{ A: noop, Pet: noop },
				[UI_SLOTS.TodoPanel],
			);
		expect(res).toEqual({ ok: true, missing: [] });
		const contributions = useUiPluginRegistry.getState().contributions;
		expect(contributions[UI_REGIONS.AppOverlay]).toHaveLength(1);
		expect(contributions[UI_REGIONS.AppOverlay]?.[0]).toMatchObject({
			pluginName: "test-plugin",
			id: "pet",
			exportName: "Pet",
			anchor: "bottom-right",
			title: "桌宠",
		});
		// 槽位注册不受影响
		expect(useUiPluginRegistry.getState().overrides[UI_SLOTS.TodoPanel]).toBeDefined();
	});

	it("同区域多插件堆叠：顺序 = 注册顺序（先注册在前）", () => {
		useUiPluginRegistry
			.getState()
			.applyPlugin(
				manifest({}, "plugin-a", [{ id: "x", region: UI_REGIONS.CornerTopRight, export: "X" }]),
				{ X: noop },
				[],
			);
		useUiPluginRegistry
			.getState()
			.applyPlugin(
				manifest({}, "plugin-b", [{ id: "y", region: UI_REGIONS.CornerTopRight, export: "Y" }]),
				{ Y: noop },
				[],
			);
		const list = useUiPluginRegistry.getState().contributions[UI_REGIONS.CornerTopRight];
		expect(list?.map((c) => c.pluginName)).toEqual(["plugin-a", "plugin-b"]);
		// 同插件可声明多条贡献（同一区域或不同区域）
		useUiPluginRegistry.getState().applyPlugin(
			manifest({}, "plugin-a", [
				{ id: "x2", region: UI_REGIONS.CornerTopRight, export: "X2" },
				{ id: "bg", region: UI_REGIONS.AppBackground, export: "Bg" },
			]),
			{ X2: noop, Bg: noop },
			[],
		);
		const list2 = useUiPluginRegistry.getState().contributions[UI_REGIONS.CornerTopRight];
		// 同插件重复 apply（热重载路径 loader 会先 remove；这里模拟不 remove 的追加）：x2 追加在尾部
		expect(list2?.map((c) => c.id)).toEqual(["x", "y", "x2"]);
		expect(useUiPluginRegistry.getState().contributions[UI_REGIONS.AppBackground]).toHaveLength(1);
	});

	it("贡献导出缺失/非组件 → 记入 missing 且不注册该条（其余贡献照常）", () => {
		const res = useUiPluginRegistry.getState().applyPlugin(
			manifest({}, "test-plugin", [
				{ id: "a", region: UI_REGIONS.AppOverlay, export: "A" },
				{ id: "b", region: UI_REGIONS.AppOverlay, export: "Missing" },
			]),
			{ A: noop },
			[],
		);
		expect(res.ok).toBe(false);
		expect(res.missing).toEqual(["app.overlay#b → Missing"]);
		const list = useUiPluginRegistry.getState().contributions[UI_REGIONS.AppOverlay];
		expect(list).toHaveLength(1);
		expect(list?.[0]?.id).toBe("a");
	});

	it("removePlugin 清贡献（含整区域清空后删 key），保留他人贡献", () => {
		useUiPluginRegistry
			.getState()
			.applyPlugin(
				manifest({}, "plugin-a", [{ id: "x", region: UI_REGIONS.CornerTopRight, export: "X" }]),
				{ X: noop },
				[],
			);
		useUiPluginRegistry
			.getState()
			.applyPlugin(
				manifest({}, "plugin-b", [{ id: "y", region: UI_REGIONS.CornerTopRight, export: "Y" }]),
				{ Y: noop },
				[],
			);
		useUiPluginRegistry.getState().removePlugin("plugin-a");
		const list = useUiPluginRegistry.getState().contributions[UI_REGIONS.CornerTopRight];
		expect(list?.map((c) => c.pluginName)).toEqual(["plugin-b"]);
		useUiPluginRegistry.getState().removePlugin("plugin-b");
		expect(useUiPluginRegistry.getState().contributions[UI_REGIONS.CornerTopRight]).toBeUndefined();
	});

	it("贡献崩溃计数与槽位共用同一套（reportCrash 按插件独立累计）", () => {
		useUiPluginRegistry
			.getState()
			.applyPlugin(
				manifest({ [UI_SLOTS.TodoPanel]: "A" }, "test-plugin", [
					{ id: "pet", region: UI_REGIONS.AppOverlay, export: "Pet" },
				]),
				{ A: noop, Pet: noop },
				[UI_SLOTS.TodoPanel],
			);
		const state = useUiPluginRegistry.getState();
		// 槽位崩 2 次 + 贡献崩 1 次 → 同一插件达到阈值
		expect(state.reportCrash("test-plugin")).toBe(false);
		expect(state.reportCrash("test-plugin")).toBe(false);
		expect(state.reportCrash("test-plugin")).toBe(true);
	});
});
