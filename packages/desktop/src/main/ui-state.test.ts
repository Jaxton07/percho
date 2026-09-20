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
