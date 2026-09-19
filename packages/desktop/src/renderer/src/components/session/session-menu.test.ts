import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { canOpenSessionMenu } from "./session-menu";

function meta(overrides: Partial<SessionMeta>): SessionMeta {
	return { sessionId: "s1", cwd: "/proj/demo", active: true, messageCount: 0, createdAt: 1, ...overrides };
}

describe("canOpenSessionMenu", () => {
	it("普通会话给菜单", () => {
		expect(canOpenSessionMenu(meta({}))).toBe(true);
	});

	it("draft（纯前端 id，后端没有该会话）不给菜单", () => {
		expect(canOpenSessionMenu(meta({ sessionId: "draft:1" }))).toBe(false);
	});

	it("只读子会话（后端拒绝写）不给菜单", () => {
		expect(canOpenSessionMenu(meta({ readOnly: true }))).toBe(false);
	});

	it("找不到会话（已关闭）不给菜单", () => {
		expect(canOpenSessionMenu(undefined)).toBe(false);
	});
});
