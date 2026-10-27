// @vitest-environment node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * loadEsbuild 的 env 现场恢复：打包态设 ESBUILD_BINARY_PATH 仅为让 esbuild 在模块求值时缓存
 * 真实二进制路径（main.js 顶层一次性读取），求值完成后必须恢复——该 env 会被主进程 spawn 的
 * 子进程（agent bash / MCP 等）继承，其他版本 esbuild 读到指向旧二进制的路径会版本不匹配崩溃。
 *
 * 测试手法：mock existsSync 使命中打包态分支 + 模拟 esbuild 自身的包解析；
 * 每个用例 vi.resetModules 拿全新 build 模块（loadEsbuild 模块级单例，否则第二例不重跑）。
 * esbuild 本体走原生 require（vitest 不拦截 node_modules CJS），不受 fs mock 影响。
 */

const realPlatform = process.platform;
const realArch = process.arch;
const resolution = vi.hoisted(() => ({
	entry: "/fake/Resources/app.asar/node_modules/esbuild/lib/main.js",
	binary: "/fake/Resources/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild",
	resolveBinary: vi.fn(),
}));

vi.mock("node:module", () => ({
	createRequire: vi.fn((filename: string) =>
		filename === resolution.entry
			? { resolve: resolution.resolveBinary }
			: { resolve: vi.fn(() => resolution.entry) },
	),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(() => true) };
});

beforeEach(() => {
	resolution.binary = "/fake/Resources/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild";
	resolution.resolveBinary.mockImplementation(() => resolution.binary);
});

async function freshLoadEsbuild() {
	vi.resetModules();
	const mod = await import("./build");
	return mod.loadEsbuild();
}

afterEach(() => {
	delete process.env.ESBUILD_BINARY_PATH;
	Object.defineProperty(process, "platform", { value: realPlatform });
	Object.defineProperty(process, "arch", { value: realArch });
	vi.clearAllMocks();
	resolution.resolveBinary.mockReset();
});

describe("loadEsbuild env 现场恢复", () => {
	it("打包态二进制存在：求值后删除 env（原本未设置）", async () => {
		delete process.env.ESBUILD_BINARY_PATH;
		const esbuild = await freshLoadEsbuild();
		expect(typeof esbuild.build).toBe("function");
		expect(process.env.ESBUILD_BINARY_PATH).toBeUndefined();
	});

	it("打包态二进制存在：求值后恢复用户预设值", async () => {
		process.env.ESBUILD_BINARY_PATH = "/user/own/esbuild";
		await freshLoadEsbuild();
		expect(process.env.ESBUILD_BINARY_PATH).toBe("/user/own/esbuild");
	});
});

describe("loadEsbuild 打包路径", () => {
	it.each([
		["win32", "x64", "esbuild.exe"],
		["win32", "arm64", "esbuild.exe"],
		["darwin", "arm64", "bin/esbuild"],
		["linux", "x64", "bin/esbuild"],
	])("解析 %s-%s 的 %s", async (platform, arch, binary) => {
		Object.defineProperty(process, "platform", { value: platform });
		Object.defineProperty(process, "arch", { value: arch });
		const relative = `node_modules/esbuild/node_modules/@esbuild/${platform}-${arch}/${binary}`;
		resolution.binary = `/fake/Resources/app.asar/${relative}`;
		await freshLoadEsbuild();
		expect(createRequire).toHaveBeenCalledWith(resolution.entry);
		expect(resolution.resolveBinary).toHaveBeenCalledWith(`@esbuild/${platform}-${arch}/${binary}`);
		expect(existsSync).toHaveBeenCalledWith(`/fake/Resources/app.asar.unpacked/${relative}`);
		expect(process.env.ESBUILD_BINARY_PATH).toBeUndefined();
	});

	it("开发态保留 esbuild 默认解析", async () => {
		resolution.binary = "/dev/node_modules/@esbuild/darwin-arm64/bin/esbuild";
		process.env.ESBUILD_BINARY_PATH = "/user/own/esbuild";
		await freshLoadEsbuild();
		expect(existsSync).not.toHaveBeenCalled();
		expect(process.env.ESBUILD_BINARY_PATH).toBe("/user/own/esbuild");
	});
	it("保留 Windows 路径分隔符", async () => {
		resolution.binary = "C:\\Percho\\resources\\app.asar\\node_modules\\@esbuild\\win32-x64\\esbuild.exe";
		await freshLoadEsbuild();
		expect(existsSync).toHaveBeenCalledWith(
			"C:\\Percho\\resources\\app.asar.unpacked\\node_modules\\@esbuild\\win32-x64\\esbuild.exe",
		);
	});

	it("可选平台包缺失时保留 esbuild 默认解析", async () => {
		resolution.resolveBinary.mockImplementationOnce(() => {
			throw new Error("Cannot find module '@esbuild/darwin-arm64/bin/esbuild'");
		});
		process.env.ESBUILD_BINARY_PATH = "/user/own/esbuild";
		await freshLoadEsbuild();
		expect(existsSync).not.toHaveBeenCalled();
		expect(process.env.ESBUILD_BINARY_PATH).toBe("/user/own/esbuild");
	});
});
