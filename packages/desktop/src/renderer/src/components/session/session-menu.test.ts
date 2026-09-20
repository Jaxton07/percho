import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { canOpenSessionMenu, sidebarMenuKind } from "./session-menu";

function meta(overrides: Partial<SessionMeta>): SessionMeta {
	return { sessionId: "s1", cwd: "/proj/demo", active: true, messageCount: 0, createdAt: 1, ...overrides };
}

describe("canOpenSessionMenu", () => {
	it("普通会话给菜单", () => {
		expect(canOpenSessionMenu(meta({}))).toBe(true);
	});

	it("只读子会话（后端拒绝写）不给菜单", () => {
		expect(canOpenSessionMenu(meta({ readOnly: true }))).toBe(false);
	});

	it("找不到会话（已关闭）不给菜单", () => {
		expect(canOpenSessionMenu(undefined)).toBe(false);
	});

	// 阶段 0 红测（spec singleton-draft-subagent-nav §8）：draft 不再是 SessionMeta，
	// 因此没有任何 id 需要被「draft 专用」特判。
	it("draft: 前缀的 id 已不存在特例：一切非只读会话都给菜单", () => {
		expect(canOpenSessionMenu(meta({ sessionId: "draft:1" }))).toBe(true);
	});
});

describe("sidebarMenuKind（左栏行右键菜单的形态判定）", () => {
	it("普通会话 → 完整菜单；只读子会话 / 找不到 → 无菜单", () => {
		expect(sidebarMenuKind(meta({}))).toBe("session");
		expect(sidebarMenuKind(meta({ readOnly: true }))).toBe("none");
		expect(sidebarMenuKind(undefined)).toBe("none");
	});

	it("新会话 draft 已不进左栏，不再存在 draft 形态", () => {
		expect(sidebarMenuKind(meta({ sessionId: "draft:1" }))).toBe("session");
	});
});
