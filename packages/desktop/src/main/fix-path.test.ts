// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mergePath, parseShellEnvPath, wellKnownBinDirs } from "./fix-path";

/**
 * fix-path 纯函数测试：GUI 启动 PATH 修复（issue #18，Finder/Dock 启动不含 /opt/homebrew/bin）。
 * side effect（改 process.env.PATH + 异步 shell 解析）在 import 时执行一次，对测试进程无害：
 * 只追加存在的目录且不删条目；异步 shell 解析失败只告警。
 */

describe("mergePath", () => {
	it("追加缺失条目并保留原顺序", () => {
		expect(mergePath("/usr/bin:/bin", ["/opt/homebrew/bin"])).toBe("/usr/bin:/bin:/opt/homebrew/bin");
	});

	it("已存在的条目去重不追加", () => {
		expect(mergePath("/usr/bin:/bin", ["/bin", "/usr/bin"])).toBe("/usr/bin:/bin");
	});

	it("过滤空条目（含 current 尾部冒号产生的空串）", () => {
		expect(mergePath("/usr/bin:", ["", "/opt/homebrew/bin"])).toBe("/usr/bin:/opt/homebrew/bin");
	});

	it("current 为空时直接由 extra 组成", () => {
		expect(mergePath("", ["/opt/homebrew/bin", "/usr/local/bin"])).toBe("/opt/homebrew/bin:/usr/local/bin");
	});
});

describe("parseShellEnvPath", () => {
	it("从 env 输出提取 PATH 行", () => {
		expect(parseShellEnvPath("HOME=/Users/x\nPATH=/a:/b:/c\nSHELL=/bin/zsh\n")).toBe("/a:/b:/c");
	});

	it("忽略 rc 打印的杂讯行", () => {
		expect(parseShellEnvPath("welcome to fish\nPATH=/x/bin\nrandom noise")).toBe("/x/bin");
	});

	it("无 PATH 行返回 null", () => {
		expect(parseShellEnvPath("HOME=/Users/x\n")).toBeNull();
	});

	it("PATH 为空串返回 null", () => {
		expect(parseShellEnvPath("PATH=\n")).toBeNull();
	});

	it("PATH 值带尾随空白/回车被裁剪", () => {
		expect(parseShellEnvPath("PATH=/a:/b\r\n")).toBe("/a:/b");
	});
});

describe("wellKnownBinDirs", () => {
	it("macOS 含 Homebrew（ARM 与 Intel）", () => {
		const dirs = wellKnownBinDirs("darwin", "/Users/x");
		expect(dirs).toContain("/opt/homebrew/bin");
		expect(dirs).toContain("/usr/local/bin");
	});

	it("Linux 不含 Homebrew，含 ~/.local/bin", () => {
		const dirs = wellKnownBinDirs("linux", "/home/x");
		expect(dirs).not.toContain("/opt/homebrew/bin");
		expect(dirs).toContain("/home/x/.local/bin");
	});

	it("Windows 返回空（注册表 PATH 无 GUI 丢失问题）", () => {
		expect(wellKnownBinDirs("win32", "C:\\Users\\x")).toEqual([]);
	});
});
