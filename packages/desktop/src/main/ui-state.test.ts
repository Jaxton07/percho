import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * main/ui-state.ts 的字段白名单测试（`lastCwd`）。
 * 用最小 electron mock 把 `app.getPath("userData")` 指到 OS 临时目录（同 backend
 * `test/permission-extension.test.ts` 的约定），不触碰真实 userData；正式目录零写入。
 */
const env = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => env.dir } }));

import { loadUiState, saveUiState } from "./ui-state";

let root = "";
const file = () => join(root, "ui-state.json");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "percho-ui-state-"));
	mkdirSync(root, { recursive: true });
	env.dir = root;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("lastCwd 白名单", () => {
	it("文件缺失时返回 null（不阻塞启动）", async () => {
		expect(await loadUiState()).toBeNull();
	});

	it("写入后读回：非空字符串收下", async () => {
		await saveUiState({ lastCwd: "/work/alpha" });
		expect((await loadUiState())?.lastCwd).toBe("/work/alpha");
	});

	it("脏值/旧文件一律落成 null（空串、非字符串、缺字段）", async () => {
		for (const raw of ['{"lastCwd":""}', '{"lastCwd":123}', '{"lastCwd":null}', "{}"]) {
			writeFileSync(file(), raw);
			expect((await loadUiState())?.lastCwd, raw).toBeNull();
		}
	});

	it("保存时保留其它字段（补丁浅合并）", async () => {
		await saveUiState({ pinnedSessions: ["s1"] });
		await saveUiState({ lastCwd: "/work/beta" });
		const state = await loadUiState();
		expect(state?.lastCwd).toBe("/work/beta");
		expect(state?.pinnedSessions).toEqual(["s1"]);
		expect(existsSync(file())).toBe(true);
	});
});

describe("expandedGroupsTouched 迁移与读写（空数组不再兼任「未操作」）", () => {
	it("缺字段 + 非空记录 → 推断为 true（旧版非空记录仍是「完全以用户选择为准」）", async () => {
		writeFileSync(file(), JSON.stringify({ expandedGroups: ["/work/alpha"] }));
		const state = await loadUiState();
		expect(state?.expandedGroupsTouched).toBe(true);
		expect(state?.expandedGroups).toEqual(["/work/alpha"]);
	});

	it("缺字段 + 空/非法记录 → false（旧版无法区分，只能继续按未操作处理）", async () => {
		for (const raw of [
			'{"expandedGroups":[]}',
			"{}",
			'{"expandedGroups":"x"}',
			'{"expandedGroups":[1,""]}',
		]) {
			writeFileSync(file(), raw);
			expect((await loadUiState())?.expandedGroupsTouched, raw).toBe(false);
		}
	});

	it("显式布尔值优先（含显式 false 配空数组、显式 true 配非空记录）", async () => {
		writeFileSync(file(), JSON.stringify({ expandedGroups: [], expandedGroupsTouched: true }));
		expect((await loadUiState())?.expandedGroupsTouched).toBe(true);

		writeFileSync(file(), JSON.stringify({ expandedGroups: ["/work/alpha"], expandedGroupsTouched: false }));
		expect((await loadUiState())?.expandedGroupsTouched).toBe(false);

		// 非布尔脏值 → 按缺字段语义推断（这里记录非空 → true）
		writeFileSync(file(), JSON.stringify({ expandedGroups: ["/work/alpha"], expandedGroupsTouched: "yes" }));
		expect((await loadUiState())?.expandedGroupsTouched).toBe(true);
	});

	it("保存补丁：显式空数组 + touched=true 能原样写盘读回（全部折叠可持久化）", async () => {
		const patch = { expandedGroups: [] as string[], expandedGroupsTouched: true };
		await saveUiState(patch);
		await saveUiState({ pinnedSessions: ["s1"] }); // 后续补丁不能把 touched 洗掉
		const state = await loadUiState();
		expect(state?.expandedGroupsTouched).toBe(true);
		expect(state?.expandedGroups).toEqual([]);
		expect(state?.pinnedSessions).toEqual(["s1"]);
	});
});

describe("sessionWorkspace 白名单（临时会话工作区）", () => {
	it("默认：工作区空 + 轨道关（旧文件无这些字段）", async () => {
		writeFileSync(file(), "{}");
		const state = await loadUiState();
		expect(state?.sessionWorkspace).toEqual({ files: [], activeFile: null });
		expect(state?.sessionRailEnabled).toBe(false);
		expect(state?.barSessionsVisible).toBe(true);
	});

	it("清洗 files：trim、去空、去重保序；activeFile 必须 ∈ files（否则 null）", async () => {
		writeFileSync(
			file(),
			JSON.stringify({
				sessionWorkspace: {
					files: [" /a.jsonl ", "", "/a.jsonl", 7, null, "/b.jsonl"],
					activeFile: "/b.jsonl",
				},
			}),
		);
		const state = await loadUiState();
		expect(state?.sessionWorkspace).toEqual({ files: ["/a.jsonl", "/b.jsonl"], activeFile: "/b.jsonl" });

		writeFileSync(
			file(),
			JSON.stringify({ sessionWorkspace: { files: ["/a.jsonl"], activeFile: "/gone.jsonl" } }),
		);
		expect((await loadUiState())?.sessionWorkspace).toEqual({ files: ["/a.jsonl"], activeFile: null });
	});

	it("脏快照（非对象/非数组/字符串元素）一律落成空，不炸启动", async () => {
		for (const raw of [
			'{"sessionWorkspace":"x"}',
			'{"sessionWorkspace":[]}',
			'{"sessionWorkspace":{"files":"x","activeFile":3}}',
			'{"sessionWorkspace":null}',
		]) {
			writeFileSync(file(), raw);
			expect((await loadUiState())?.sessionWorkspace, raw).toEqual({ files: [], activeFile: null });
		}
	});

	it("两个显示入口都关掉时强制清空（即使文件里留着上次的快照）", async () => {
		writeFileSync(
			file(),
			JSON.stringify({
				barSessionsVisible: false,
				sessionRailEnabled: false,
				sessionWorkspace: { files: ["/a.jsonl"], activeFile: "/a.jsonl" },
			}),
		);
		expect((await loadUiState())?.sessionWorkspace).toEqual({ files: [], activeFile: null });
	});

	it("旧用户 barSessionsVisible:false 且缺 rail 字段 → 保持关 + 工作区空", async () => {
		writeFileSync(
			file(),
			JSON.stringify({
				barSessionsVisible: false,
				sessionWorkspace: { files: ["/a.jsonl"], activeFile: "/a.jsonl" },
			}),
		);
		const state = await loadUiState();
		expect(state?.barSessionsVisible).toBe(false);
		expect(state?.sessionRailEnabled).toBe(false);
		expect(state?.sessionWorkspace).toEqual({ files: [], activeFile: null });
	});

	it("只关一处不清空（轨道单开时成员保留）", async () => {
		writeFileSync(
			file(),
			JSON.stringify({
				barSessionsVisible: false,
				sessionRailEnabled: true,
				sessionWorkspace: { files: ["/a.jsonl", "/b.jsonl"], activeFile: "/a.jsonl" },
			}),
		);
		expect((await loadUiState())?.sessionWorkspace).toEqual({
			files: ["/a.jsonl", "/b.jsonl"],
			activeFile: "/a.jsonl",
		});
	});

	it("升级不迁移：旧的 pinnedSessions 不会变成工作区成员（置顶仍是独立的长期标记）", async () => {
		writeFileSync(file(), JSON.stringify({ pinnedSessions: ["s1", "s2"], barSessionsVisible: true }));
		const state = await loadUiState();
		expect(state?.pinnedSessions).toEqual(["s1", "s2"]);
		expect(state?.sessionWorkspace).toEqual({ files: [], activeFile: null });
		expect(state?.sessionRailEnabled).toBe(false);
	});

	it("同一次保存补丁可同时改开关与快照（读回一致）", async () => {
		await saveUiState({
			sessionRailEnabled: true,
			sessionWorkspace: { files: ["/a.jsonl", "/b.jsonl"], activeFile: "/b.jsonl" },
		});
		const state = await loadUiState();
		expect(state?.sessionRailEnabled).toBe(true);
		expect(state?.sessionWorkspace).toEqual({ files: ["/a.jsonl", "/b.jsonl"], activeFile: "/b.jsonl" });
	});
});

describe("sessionPermissionModes 白名单（D7：按会话记住权限模式）", () => {
	it("只收 fullAccess，且丢掉 default 与非法值", async () => {
		writeFileSync(
			file(),
			JSON.stringify({
				sessionPermissionModes: { a: "fullAccess", b: "default", c: "root", d: 3, "": "fullAccess" },
			}),
		);
		expect((await loadUiState())?.sessionPermissionModes).toEqual({ a: "fullAccess" });
	});

	it("非对象（数组/字符串/数字/null）一律落成 {}，不炸启动", async () => {
		for (const raw of [
			'{"sessionPermissionModes":[]}',
			'{"sessionPermissionModes":"x"}',
			'{"sessionPermissionModes":7}',
			'{"sessionPermissionModes":null}',
			"{}",
		]) {
			writeFileSync(file(), raw);
			expect((await loadUiState())?.sessionPermissionModes).toEqual({});
		}
	});

	it("写入后读回：非默认档位保留", async () => {
		await saveUiState({ sessionPermissionModes: { s1: "fullAccess" } });
		expect((await loadUiState())?.sessionPermissionModes).toEqual({ s1: "fullAccess" });
	});
});

describe("sidebarWidth 白名单（用户意图宽度）", () => {
	it("缺字段 → 默认 240（旧文件/没拖过的用户）", async () => {
		writeFileSync(file(), "{}");
		expect((await loadUiState())?.sidebarWidth).toBe(240);
	});

	it("上下界原样保留（200 / 480 都合法）", async () => {
		await saveUiState({ sidebarWidth: 200 });
		expect((await loadUiState())?.sidebarWidth).toBe(200);
		await saveUiState({ sidebarWidth: 480 });
		expect((await loadUiState())?.sidebarWidth).toBe(480);
	});

	it("越界（手改文件/未来改上下界）读回时 clamp 而不是丢弃", async () => {
		writeFileSync(file(), '{"sidebarWidth":100}');
		expect((await loadUiState())?.sidebarWidth).toBe(200);
		writeFileSync(file(), '{"sidebarWidth":900}');
		expect((await loadUiState())?.sidebarWidth).toBe(480);
	});

	it("非有限数一律回默认（字符串/null/数组/NaN）", async () => {
		for (const raw of [
			'{"sidebarWidth":"300"}',
			'{"sidebarWidth":null}',
			'{"sidebarWidth":[]}',
			'{"sidebarWidth":true}',
		]) {
			writeFileSync(file(), raw);
			expect((await loadUiState())?.sidebarWidth, raw).toBe(240);
		}
	});

	it("小数取整（拖拽可能算出小数）", async () => {
		writeFileSync(file(), '{"sidebarWidth":312.6}');
		expect((await loadUiState())?.sidebarWidth).toBe(313);
	});

	it("保存补丁不冲掉其它字段、也不被其它补丁冲掉", async () => {
		await saveUiState({ sidebarWidth: 320 });
		await saveUiState({ pinnedSessions: ["s1"] });
		const state = await loadUiState();
		expect(state?.sidebarWidth).toBe(320);
		expect(state?.pinnedSessions).toEqual(["s1"]);
	});
});

describe("windowBounds 白名单（normal 态窗口位置与尺寸）", () => {
	it("缺字段 / 没记过 → null", async () => {
		writeFileSync(file(), "{}");
		expect((await loadUiState())?.windowBounds).toBeNull();
	});

	it("合法值原样保留（含 x/y 为负的左侧副屏）", async () => {
		writeFileSync(file(), '{"windowBounds":{"x":-1000,"y":40,"width":900,"height":620}}');
		expect((await loadUiState())?.windowBounds).toEqual({ x: -1000, y: 40, width: 900, height: 620 });
	});

	it("小于最小尺寸 → null（否则窗口构造会失败）", async () => {
		writeFileSync(file(), '{"windowBounds":{"x":0,"y":0,"width":639,"height":620}}');
		expect((await loadUiState())?.windowBounds).toBeNull();
		writeFileSync(file(), '{"windowBounds":{"x":0,"y":0,"width":900,"height":479}}');
		expect((await loadUiState())?.windowBounds).toBeNull();
	});

	it("字段缺失 / 类型不对 / 非有限数 → null", async () => {
		for (const raw of [
			'{"windowBounds":{"x":0,"y":0,"width":900}}',
			'{"windowBounds":{"x":"0","y":0,"width":900,"height":620}}',
			'{"windowBounds":{"x":0,"y":0,"width":null,"height":620}}',
			'{"windowBounds":[]}',
			'{"windowBounds":"x"}',
			'{"windowBounds":7}',
			'{"windowBounds":null}',
		]) {
			writeFileSync(file(), raw);
			expect((await loadUiState())?.windowBounds, raw).toBeNull();
		}
	});

	it("小数取整（窗口尺寸本来就是整数，脏文件也不写成浮点）", async () => {
		writeFileSync(file(), '{"windowBounds":{"x":10.6,"y":20.2,"width":900.4,"height":620.5}}');
		expect((await loadUiState())?.windowBounds).toEqual({ x: 11, y: 20, width: 900, height: 621 });
	});

	it("保存补丁：写一次能读回；后续补丁不冲掉它", async () => {
		await saveUiState({ windowBounds: { x: 50, y: 60, width: 900, height: 620 } });
		await saveUiState({ pinnedSessions: ["s1"] });
		const state = await loadUiState();
		expect(state?.windowBounds).toEqual({ x: 50, y: 60, width: 900, height: 620 });
		expect(state?.pinnedSessions).toEqual(["s1"]);
	});
});
