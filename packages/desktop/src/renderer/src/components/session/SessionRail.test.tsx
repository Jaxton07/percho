// @vitest-environment happy-dom
import type { SessionMeta } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectsStore } from "../../stores/projects";
import { useSessionWorkspaceStore } from "../../stores/session-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { SessionRail } from "./SessionRail";

const availability = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../lib/session-rail-availability", () => ({
	get SESSION_RAIL_AVAILABLE() {
		return availability.enabled;
	},
}));

const api = vi.hoisted(() => ({
	saveUiState: vi.fn(async () => {}),
	loadUiState: vi.fn(async () => ({})),
}));
vi.mock("../../api", () => ({ getPi: () => api }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

const initialRailEnabled = useUiPreferencesStore.getState().sessionRailEnabled;
const openSession = vi.fn(async () => {});
const draft = vi.fn();
const sessions = ["a", "b", "c", "d"].map(
	(id) =>
		({
			sessionId: id,
			sessionFile: `/${id}.jsonl`,
			cwd: "/project",
			name: `Session ${id}`,
		}) as SessionMeta,
);
const members = sessions.map((s) => ({ sessionId: s.sessionId, file: s.sessionFile as string }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frames: FrameRequestCallback[];

beforeEach(() => {
	availability.enabled = true;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	frames = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.clearAllMocks();
	useUiPreferencesStore.setState({
		barSessionsVisible: true,
		sessionRailEnabled: false,
		pinnedSessions: ["b"],
	});
	useSessionWorkspaceStore.setState({ members, activeFile: "/b.jsonl", recentFile: "/b.jsonl" });
	useSessionsStore.setState({
		sessions: sessions.filter((session) => session.sessionId === "b"),
		activeSessionId: "b",
		activateNewSessionDraft: draft,
	});
	useProjectsStore.setState({
		allSessions: [...sessions].reverse(),
		openSession,
	});
	useUiStore.setState({ diffSidebarOpen: false });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
const render = async () => act(async () => root.render(<SessionRail />));
const enable = async () => act(async () => useUiPreferencesStore.getState().setSessionRailEnabled(true));
const item = (id: string) => {
	const element = host.querySelector<HTMLButtonElement>(`[data-rail-session-id="${id}"]`);
	if (!element) throw new Error(`Missing rail item ${id}`);
	return element;
};
const key = async (id: string, value: string) =>
	act(async () => {
		item(id).dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
	});
const flushFrames = async () =>
	act(async () => {
		for (const callback of frames.splice(0)) callback(0);
	});

describe("SessionRail", () => {
	it("暂停展示期间忽略旧开启偏好，但不清理偏好或工作区", async () => {
		const actual = await vi.importActual<typeof import("../../lib/session-rail-availability")>(
			"../../lib/session-rail-availability",
		);
		expect(actual.SESSION_RAIL_AVAILABLE).toBe(false);
		availability.enabled = actual.SESSION_RAIL_AVAILABLE;
		await enable();
		await render();
		expect(host.querySelector("[data-session-rail]")).toBeNull();
		expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(true);
		expect(useSessionWorkspaceStore.getState().members).toEqual(members);
	});

	it("实际偏好初值及旧偏好恢复均默认关闭，即使工作区有成员也不显示", async () => {
		expect(initialRailEnabled).toBe(false);
		await useUiPreferencesStore.getState().init();
		expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(false);
		await render();
		expect(host.querySelector("[data-session-rail]")).toBeNull();
		expect(useSessionWorkspaceStore.getState().members).toEqual(members);
	});
	it("开启后按工作区顺序展示，已加载数据优先，点击未加载会话按需打开", async () => {
		await enable();
		await render();
		const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-rail-session-id]")];
		expect(buttons.map((b) => b.dataset.railSessionId)).toEqual(["a", "b", "c", "d"]);
		expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false"]);
		expect(item("a").getAttribute("aria-label")).toContain("Session a");
		await act(async () => item("a").click());
		expect(openSession).toHaveBeenCalledExactlyOnceWith(sessions[0]);
	});
	it("悬停形成邻近波浪，移出收起；方向键移动焦点并在边界停止", async () => {
		await enable();
		await render();
		await act(async () => item("b").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		expect(item("b").classList.contains("is-expanded")).toBe(true);
		expect(item("a").classList.contains("is-near-1")).toBe(true);
		expect(item("c").classList.contains("is-near-1")).toBe(true);
		expect(item("d").classList.contains("is-near-2")).toBe(true);
		await act(async () => item("b").dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
		expect(host.querySelector(".is-expanded")).toBeNull();
		await act(async () => item("a").focus());
		await key("a", "ArrowDown");
		expect(document.activeElement).toBe(item("b"));
		expect(item("b").classList.contains("is-expanded")).toBe(true);
		await key("b", "ArrowUp");
		await key("a", "ArrowUp");
		expect(document.activeElement).toBe(item("a"));
	});
	it("移除仅影响工作区，当前项让位右邻，键盘焦点跟随；末项回草稿", async () => {
		await enable();
		await render();
		await act(async () =>
			item("a").querySelector<HTMLElement>('[title="tabbar.removeFromWorkspace"]')?.click(),
		);
		expect(openSession).not.toHaveBeenCalled();
		expect(useSessionWorkspaceStore.getState().members.map((m) => m.sessionId)).toEqual(["b", "c", "d"]);
		await act(async () => item("b").focus());
		await key("b", "Delete");
		await flushFrames();
		expect(openSession).toHaveBeenCalledExactlyOnceWith(sessions[2]);
		expect(document.activeElement).toBe(item("c"));
		expect(useUiPreferencesStore.getState().pinnedSessions).toEqual(["b"]);
		expect(useSessionsStore.getState().sessions).toEqual([sessions[1]]);
		await key("c", "Backspace");
		await flushFrames();
		expect(openSession).toHaveBeenLastCalledWith(sessions[3]);
		await key("d", "Delete");
		expect(draft).toHaveBeenCalledOnce();
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		expect(host.querySelector("[data-session-rail]")).toBeNull();
	});
	it("Diff 开关更新避让标记；关闭轨道只隐藏，顶栏启用时不清空成员", async () => {
		await enable();
		await render();
		expect(host.querySelector("[data-session-rail]")?.hasAttribute("data-diff-open")).toBe(false);
		await act(async () => useUiStore.setState({ diffSidebarOpen: true }));
		expect(host.querySelector("[data-session-rail]")?.getAttribute("data-diff-open")).toBe("true");
		await act(async () => useUiStore.setState({ diffSidebarOpen: false }));
		expect(host.querySelector("[data-session-rail]")?.hasAttribute("data-diff-open")).toBe(false);
		await act(async () => useUiPreferencesStore.getState().setSessionRailEnabled(false));
		expect(host.querySelector("[data-session-rail]")).toBeNull();
		expect(useSessionWorkspaceStore.getState().members).toEqual(members);
		await enable();
		expect(host.querySelectorAll("[data-rail-session-id]")).toHaveLength(4);
	});
});
