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
