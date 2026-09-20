import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { sessionAvatarClass, sessionLetter, sessionProjectDir, sessionTitle } from "./session-status";

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

// 顶栏胶囊 / 左侧轨道 / 悬浮列表三处共用这一份色板：优先级写错就是三处视觉不一致
describe("sessionAvatarClass", () => {
	const opts = { isActive: false, daily: false };

	it("只读子代理优先于一切状态", () => {
		expect(sessionAvatarClass("working", { isActive: true, daily: true, readOnly: true })).toBe(
			"bg-accent text-on-accent",
		);
	});

	it("状态色（审批 / 工作中）优先于日常与当前会话", () => {
		expect(sessionAvatarClass("attention", { isActive: true, daily: true })).toBe("bg-amber-500 text-on-ink");
		expect(sessionAvatarClass("working", { isActive: true, daily: true })).toBe(
			"bg-ink text-on-ink tab-avatar-working",
		);
	});

	it("日常空间余态 = 画布底 + 细边框（白底黑字，与项目条目的黑底白字反相）", () => {
		expect(sessionAvatarClass("idle", { isActive: false, daily: true })).toBe(
			"border border-border-strong bg-canvas text-ink",
		);
		expect(sessionAvatarClass("done", { isActive: true, daily: true })).toBe(
			"border border-border-strong bg-canvas text-ink",
		);
	});

	it("项目余态：当前会话墨底 / 其余浅灰底", () => {
		expect(sessionAvatarClass("idle", { isActive: true, daily: false })).toBe("bg-ink text-on-ink");
		expect(sessionAvatarClass("idle", opts)).toBe("bg-ink-faint text-on-ink");
	});
});
