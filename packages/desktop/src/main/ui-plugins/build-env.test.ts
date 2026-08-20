// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * loadEsbuild 的 env 现场恢复：打包态设 ESBUILD_BINARY_PATH 仅为让 esbuild 在模块求值时缓存
 * 真实二进制路径（main.js 顶层一次性读取），求值完成后必须恢复——该 env 会被主进程 spawn 的
 * 子进程（agent bash / MCP 等）继承，其他版本 esbuild 读到指向旧二进制的路径会版本不匹配崩溃。
 *
 * 测试手法：mock existsSync 使命中打包态分支 + 伪造 process.resourcesPath；
 * 每个用例 vi.resetModules 拿全新 build 模块（loadEsbuild 模块级单例，否则第二例不重跑）。
 * esbuild 本体走原生 require（vitest 不拦截 node_modules CJS），不受 fs mock 影响。
 */

const realResourcesPath = process.resourcesPath;

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(() => true) };
});

function fakePackagedEnv() {
	Object.defineProperty(process, "resourcesPath", {
		value: "/fake/Percho.app/Contents/Resources",
		configurable: true,
		writable: true,
	});
}

async function freshLoadEsbuild() {
	vi.resetModules();
	const mod = await import("./build");
	return mod.loadEsbuild();
}

afterEach(() => {
	if (realResourcesPath === undefined) delete (process as { resourcesPath?: string }).resourcesPath;
	else
		Object.defineProperty(process, "resourcesPath", {
			value: realResourcesPath,
			configurable: true,
			writable: true,
		});
	delete process.env.ESBUILD_BINARY_PATH;
});

describe("loadEsbuild env 现场恢复", () => {
	it("打包态二进制存在：求值后删除 env（原本未设置）", async () => {
		fakePackagedEnv();
		delete process.env.ESBUILD_BINARY_PATH;
		const esbuild = await freshLoadEsbuild();
		expect(typeof esbuild.build).toBe("function");
		expect(process.env.ESBUILD_BINARY_PATH).toBeUndefined();
	});

	it("打包态二进制存在：求值后恢复用户预设值", async () => {
		fakePackagedEnv();
		process.env.ESBUILD_BINARY_PATH = "/user/own/esbuild";
		await freshLoadEsbuild();
		expect(process.env.ESBUILD_BINARY_PATH).toBe("/user/own/esbuild");
	});
});
