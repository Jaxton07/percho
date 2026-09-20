import type { SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionsStore } from "../../stores/sessions";
import { canOpenSessionMenu, discardDraft, sidebarMenuKind } from "./session-menu";

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

describe("sidebarMenuKind（左栏行右键菜单的形态判定）", () => {
	it("draft → 最小菜单；普通会话 → 完整菜单；只读子会话/找不到 → 无菜单", () => {
		expect(sidebarMenuKind(meta({ sessionId: "draft:1" }))).toBe("draft");
		expect(sidebarMenuKind(meta({}))).toBe("session");
		expect(sidebarMenuKind(meta({ readOnly: true }))).toBe("none");
		expect(sidebarMenuKind(undefined)).toBe("none");
	});
});

describe("discardDraft（draft 的丢弃动作）", () => {
	beforeEach(() => {
		useSessionsStore.setState({ sessions: [], activeSessionId: null, cwd: null, permissionModes: {} });
	});

	it("纯本地移除：draft 没有后端会话，不调 IPC，也不影响其它会话", () => {
		useSessionsStore.setState({
			sessions: [meta({ sessionId: "draft:1", cwd: "/p" }), meta({ sessionId: "r1", cwd: "/p" })],
			activeSessionId: "draft:1",
		});
		discardDraft("draft:1");
		const state = useSessionsStore.getState();
		expect(state.sessions.map((s) => s.sessionId)).toEqual(["r1"]);
		expect(state.activeSessionId).toBe("r1");
	});
});
