import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import type { Translate } from "../../i18n";
import { useChannelSubscriptionsStore } from "../../stores/channel-subscriptions";
import { canOpenSessionMenu, sessionMenuItems, sidebarMenuKind } from "./session-menu";

function meta(overrides: Partial<SessionMeta>): SessionMeta {
	return { sessionId: "s1", cwd: "/proj/demo", active: true, messageCount: 0, createdAt: 1, ...overrides };
}

describe("archive menu", () => {
	it("shows media and archive icons while preserving disabled archive behavior", () => {
		const items = sessionMenuItems(((key: string) => key) as Translate, {
			sessionId: "s1",
			session: meta({ readOnly: true }),
			pinned: false,
			onRename: () => {},
			onMediaMaintenance: () => {},
		});
		expect(items.find((item) => item.key === "media-maintenance")?.icon).toBeTruthy();
		expect(items.find((item) => item.key === "archive")).toMatchObject({
			disabled: true,
			icon: expect.anything(),
		});
	});

	it("appears before delete and explains active subscriptions", () => {
		useChannelSubscriptionsStore.setState({
			bySession: { s1: { topics: ["news"], revision: 1, generation: 1 } },
		});
		const items = sessionMenuItems(((key: string) => key) as Translate, {
			sessionId: "s1",
			session: meta({ sessionFile: "/a", messageCount: 1 }),
			pinned: false,
			onRename: () => {},
			onDelete: () => {},
		});
		expect(items.map((item) => item.key).slice(-2)).toEqual(["archive", "delete"]);
		expect(items.find((item) => item.key === "archive")).toMatchObject({
			disabled: false,
			tooltip: "sessionArchive.subscriptions",
		});
		useChannelSubscriptionsStore.setState({ bySession: {} });
	});
});

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
});

describe("sidebarMenuKind（左栏行右键菜单的形态判定）", () => {
	it("普通会话 → 完整菜单；只读子会话 / 找不到 → 无菜单", () => {
		expect(sidebarMenuKind(meta({}))).toBe("session");
		expect(sidebarMenuKind(meta({ readOnly: true }))).toBe("none");
		expect(sidebarMenuKind(undefined)).toBe("none");
	});
});
