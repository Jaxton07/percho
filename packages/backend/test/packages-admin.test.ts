import { NPM_NOT_FOUND_SENTINEL } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { isNpmSpawnEnoent } from "../src/packages/admin";

/**
 * npm ENOENT 错误识别（issue #18：GUI 启动 PATH 不含 npm → spawn npm ENOENT）。
 * 命中时抛带 PERCHO_NPM_NOT_FOUND 哨兵的可读错误，renderer 映射为 i18n 文案。
 */

describe("isNpmSpawnEnoent", () => {
	it("裸 spawn npm ENOENT 消息", () => {
		expect(isNpmSpawnEnoent(new Error("spawn npm ENOENT"))).toBe(true);
	});

	it("Electron IPC 包装后的消息（用户实际看到的形态）", () => {
		expect(
			isNpmSpawnEnoent(new Error("Error invoking remote method 'packages:install': Error: spawn npm ENOENT")),
		).toBe(true);
	});

	it("Windows npm.cmd 形态", () => {
		expect(isNpmSpawnEnoent(new Error("spawn npm.cmd ENOENT"))).toBe(true);
	});

	it("带 code/syscall 属性的原始 spawn 错误", () => {
		const err = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT", syscall: "spawn npm" });
		expect(isNpmSpawnEnoent(err)).toBe(true);
	});

	it("其他命令的 ENOENT 不误判", () => {
		expect(isNpmSpawnEnoent(new Error("spawn git ENOENT"))).toBe(false);
		expect(isNpmSpawnEnoent(Object.assign(new Error("x"), { code: "ENOENT", syscall: "spawn git" }))).toBe(
			false,
		);
	});

	it("普通网络/安装错误不误判", () => {
		expect(isNpmSpawnEnoent(new Error("npm ERR! network request failed"))).toBe(false);
		expect(isNpmSpawnEnoent(new Error("ENOENT: no such file or directory, open '/x/package.json'"))).toBe(
			false,
		);
		expect(isNpmSpawnEnoent("some string error")).toBe(false);
	});
});

describe("NPM_NOT_FOUND_SENTINEL", () => {
	it("哨兵值稳定（renderer 依赖此前缀做 i18n 映射）", () => {
		expect(NPM_NOT_FOUND_SENTINEL).toBe("PERCHO_NPM_NOT_FOUND");
	});
});
