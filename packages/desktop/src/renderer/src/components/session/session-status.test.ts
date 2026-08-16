import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { sessionLetter, sessionProjectDir, sessionTitle } from "./session-status";

function meta(overrides: Partial<SessionMeta>): SessionMeta {
	return { sessionId: "s1", cwd: "/proj/demo", active: true, messageCount: 0, createdAt: 1, ...overrides };
}

describe("sessionTitle", () => {
	it("优先用户/自动命名", () => {
		expect(sessionTitle(meta({ name: "重构权限模块" }), "未命名会话")).toBe("重构权限模块");
	});

	it("无标题回落项目目录末级", () => {
		expect(sessionTitle(meta({ cwd: "/work/code/ai/percho" }), "未命名会话")).toBe("percho");
	});

	it("无目录时回落未命名占位", () => {
		expect(sessionTitle(meta({ cwd: "/" }), "Untitled")).toBe("Untitled");
	});
});

describe("sessionProjectDir", () => {
	it("取 cwd 末级", () => {
		expect(sessionProjectDir(meta({ cwd: "/a/b/c" }))).toBe("c");
		expect(sessionProjectDir(meta({ cwd: "/" }))).toBe("");
	});
});

describe("sessionLetter", () => {
	it("项目名首字母，无则 P", () => {
		expect(sessionLetter(meta({ cwd: "/work/ai-ops" }))).toBe("a");
		expect(sessionLetter(meta({ cwd: "/" }))).toBe("P");
	});
});
