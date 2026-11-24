// @vitest-environment happy-dom
import {
	environmentEntityKey,
	environmentKey,
	LOCAL_ENVIRONMENT,
	type SessionCatalogPage,
} from "@percho/shared";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerEnvironment } from "../../environment-registry";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { sessionCatalogPageKey, useSessionCatalogStore } from "../../stores/session-catalog";
import { useSessionsStore } from "../../stores/sessions";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { Sidebar } from "./Sidebar";

vi.hoisted(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} }));
const api = vi.hoisted(() => ({
	querySessionCatalog: vi.fn(),
	querySessionProjects: vi.fn(),
	onSessionCatalogChanged: vi.fn(() => () => {}),
	saveUiState: vi.fn(async () => {}),
}));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => api }));
vi.mock("../../api", () => ({ getPi: () => api }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../lib/use-edge-fade", () => ({ useEdgeFade: () => {} }));
vi.mock("./useSidebarRenderWidth", () => ({ useSidebarRenderWidth: () => 240 }));
vi.mock("./SidebarHeader", () => ({ SidebarHeader: () => null }));
vi.mock("./SidebarFooter", () => ({ SidebarFooter: () => null }));
vi.mock("./SidebarResizeHandle", () => ({ SidebarResizeHandle: () => null }));
vi.mock("./AddProjectDialog", () => ({ AddProjectDialog: () => null }));
vi.mock("./ProjectRow", () => ({
	ProjectRow: ({ label, onToggle }: { label: string; onToggle: () => void }) => (
		<button type="button" onClick={onToggle}>
			{label}
		</button>
	),
}));
vi.mock("./SessionMenu", () => ({ useSessionMenu: () => ({ open: vi.fn(), element: null }) }));

const cwd = "/project";
const key = environmentKey(LOCAL_ENVIRONMENT);
let host: HTMLDivElement;
let root: Root;
let unregisterRemote: (() => void) | undefined;
const result = (patch: Partial<SessionCatalogPage> = {}): SessionCatalogPage => ({
	sessions: [],
	revision: "1",
	complete: false,
	errors: 1,
	scan: null,
	diagnostics: { errors: 1, reasons: { unreadable: 1 } },
	...patch,
});
const current = () =>
	useSessionCatalogStore.getState().byEnvironment[key]?.pages[
		sessionCatalogPageKey({ cwd, archived: false })
	];
async function render(expanded: boolean) {
	await act(async () => {
		useUiPreferencesStore.setState({ expandedGroups: expanded ? [cwd] : [] });
		root.render(<Sidebar />);
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.clearAllMocks();
	useSessionCatalogStore.getState().clear();
	useRemoteConnectionStore.setState({ status: { revision: 1, state: "disconnected" } });
	useSessionsStore.setState({ sessions: [], activeSessionId: null, newSessionDraft: null });
	useProjectsStore.setState({ addedProjects: [cwd], allSessions: [], search: "" });
	useUiPreferencesStore.setState({
		sidebarCollapsed: false,
		expandedGroupsTouched: true,
		expandedGroups: [],
		pinnedProjects: [],
		pinnedSessions: [],
	});
	api.querySessionProjects.mockResolvedValue({
		projects: [],
		revision: "1",
		complete: false,
		errors: 1,
		scan: null,
	});
	api.querySessionCatalog.mockResolvedValue(result());
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	unregisterRemote?.();
	unregisterRemote = undefined;
	useSessionCatalogStore.getState().clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("首次展开请求 effect 运行前也不闪现加载提示", async () => {
	let firstPaint = "";
	function CaptureFirstPaint() {
		useLayoutEffect(() => {
			firstPaint = host.textContent ?? "";
		}, []);
		return null;
	}
	await act(async () => {
		useUiPreferencesStore.setState({ expandedGroups: [cwd] });
		root.render(
			<>
				<Sidebar />
				<CaptureFirstPaint />
			</>,
		);
	});
	expect(firstPaint).toContain("project");
	expect(firstPaint).not.toContain("sidebar.catalogLoading");
});

it("首次项目发现失败且没有分组时，项目区提供本机项目列表重试入口", async () => {
	useProjectsStore.setState({ addedProjects: [] });
	api.querySessionProjects.mockRejectedValueOnce(new Error("discovery unavailable"));
	await render(false);
	const retry = [...host.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("sidebar.catalogLocalProjectsRetry"),
	);
	expect(retry).toBeDefined();
	if (!retry) throw new Error("Missing project discovery retry");
	api.querySessionProjects.mockResolvedValue({
		projects: [{ cwd, sessionCount: 1, archivedCount: 0, lastActive: 1 }],
		complete: true,
		errors: 0,
		revision: "recovered",
	});
	await act(async () => retry.click());
	expect(api.querySessionProjects).toHaveBeenCalledTimes(2);
	expect(host.textContent).toContain("project");
	expect(host.textContent).not.toContain("sidebar.catalogLocalProjectsRetry");
	expect(host.textContent).not.toContain("sidebar.catalogPartial");
});

it("本机已有项目时仍展示没有项目的远端首次发现失败入口", async () => {
	const remote = { kind: "ssh", connectionId: "host", environmentId: "remote" } as const;
	unregisterRemote = registerEnvironment(remote);
	useRemoteConnectionStore.setState({ status: { revision: 1, state: "connected", environment: remote } });
	api.querySessionProjects.mockResolvedValueOnce({
		projects: [{ cwd, sessionCount: 1, archivedCount: 0, lastActive: 1 }],
		revision: "local",
		complete: true,
		errors: 0,
		scan: null,
	});
	api.querySessionProjects.mockRejectedValueOnce(new Error("remote unavailable"));
	await render(false);
	expect(host.textContent).toContain("project");
	expect(host.textContent).toContain("sidebar.catalogRemoteProjectsRetry");
	expect(host.textContent).not.toContain("sidebar.catalogLocalProjectsRetry");
});

it("目录以扫描诊断返回首次发现故障时仍提供真实重新扫描的入口", async () => {
	useProjectsStore.setState({ addedProjects: [] });
	api.querySessionProjects.mockResolvedValue({
		projects: [],
		revision: "1",
		complete: false,
		errors: 1,
		scan: null,
		diagnostics: { errors: 1, reasons: { discovery: 1 } },
	});
	await render(false);
	const retry = [...host.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("sidebar.catalogLocalProjectsRetry"),
	);
	expect(retry).toBeDefined();
	if (!retry) throw new Error("Missing diagnostic retry");
	api.querySessionProjects.mockResolvedValue({
		projects: [{ cwd, sessionCount: 1, archivedCount: 0, lastActive: 1 }],
		complete: true,
		errors: 0,
		revision: "recovered",
		scan: null,
	});
	api.querySessionCatalog.mockResolvedValue(result({ complete: true, errors: 0, scan: null }));
	await act(async () => retry.click());
	expect(api.querySessionCatalog).toHaveBeenCalledWith({ query: { limit: 1, refresh: true } });
	expect(host.textContent).not.toContain("sidebar.catalogLocalProjectsRetry");
});

it.each(["issues", "error"])("%s 的重试在途时禁用按钮，避免重复请求", async (kind) => {
	if (kind === "error") api.querySessionCatalog.mockRejectedValueOnce(new Error("failed"));
	await render(true);
	const label = kind === "issues" ? "sidebar.catalogIssues" : "sidebar.catalogRetry";
	const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(label));
	if (!retry) throw new Error("Missing retry");
	let finish: (page: SessionCatalogPage) => void = () => {};
	api.querySessionCatalog.mockReturnValue(
		new Promise<SessionCatalogPage>((resolve) => {
			finish = resolve;
		}),
	);
	await act(async () => retry.click());
	expect(retry.disabled).toBe(true);
	const calls = api.querySessionCatalog.mock.calls.length;
	await act(async () => retry.click());
	expect(api.querySessionCatalog).toHaveBeenCalledTimes(calls);
	await act(async () =>
		finish(result({ complete: true, errors: 0, diagnostics: { errors: 0, reasons: {} } })),
	);
	expect(host.textContent).not.toContain(label);
});

it("收起的项目不显示目录状态，侧栏底部也不泄漏全局整理提示", async () => {
	await render(false);
	expect(host.textContent).not.toContain("sidebar.catalogPartial");
	expect(host.textContent).not.toContain("sidebar.catalogRetry");
	expect(api.querySessionCatalog).not.toHaveBeenCalled();
	expect(host.textContent).not.toContain("sidebar.catalogLocalProjectsRetry");
});

it("展开后仅显示该项目异常，收起后立即移除状态和重试入口", async () => {
	await render(true);
	expect(host.textContent).toContain("sidebar.catalogIssues");
	expect(host.textContent).not.toContain("sidebar.catalogPartial");
	expect(host.textContent).not.toContain("sidebar.catalogUpdating");
	await render(false);
	expect(host.textContent).not.toContain("sidebar.catalogIssues");
	expect(host.querySelector('[role="status"]')).toBeNull();
});

it("其他项目或未知归属的异常不复制为本项目异常，只说明列表可能不完整", async () => {
	api.querySessionCatalog.mockResolvedValue(result({ diagnostics: { errors: 0, reasons: {} } }));
	await render(true);
	expect(host.textContent).not.toContain("sidebar.catalogIssues");
	expect(host.textContent).toContain("sidebar.catalogPartial");
	expect(host.textContent).not.toContain("sidebar.noSessions");
});

it("处理中超过两秒才提示，收起即隐藏，再次展开不重置活动时间", async () => {
	const scan = { id: "scan", startedAt: Date.now() };
	api.querySessionCatalog.mockResolvedValue(
		result({ errors: 0, diagnostics: { errors: 0, reasons: {} }, scan }),
	);
	await render(true);
	expect(host.textContent).not.toContain("sidebar.catalogUpdating");
	await act(() => vi.advanceTimersByTime(1999));
	expect(host.textContent).not.toContain("sidebar.catalogUpdating");
	await act(() => vi.advanceTimersByTime(1));
	expect(host.textContent).toContain("sidebar.catalogUpdating");
	await render(false);
	expect(host.textContent).not.toContain("sidebar.catalogUpdating");
	await act(() => vi.advanceTimersByTime(10000));
	expect(host.textContent).not.toContain("sidebar.catalogUpdating");
	await render(true);
	expect(host.textContent).toContain("sidebar.catalogUpdating");

	api.querySessionCatalog.mockResolvedValue(
		result({ complete: true, errors: 0, scan: null, diagnostics: { errors: 0, reasons: {} } }),
	);
	await act(() => useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, { cwd, archived: false }));
	expect(current()?.complete).toBe(true);
	expect(host.textContent).not.toContain("sidebar.catalogUpdating");
	expect(host.textContent).toContain("sidebar.noSessions");
});

it("多个展开项目的异常各自归属，远端断开后仅显示离线且收起立即隐藏", async () => {
	const remote = { kind: "ssh", connectionId: "host", environmentId: "remote" } as const;
	const remoteCwd = environmentEntityKey(remote, "/remote");
	unregisterRemote = registerEnvironment(remote);
	useProjectsStore.setState({ addedProjects: [cwd, "/healthy", remoteCwd] });
	useSessionCatalogStore.setState((state) => ({
		byEnvironment: {
			...state.byEnvironment,
			[environmentKey(remote)]: {
				projects: { projects: [], revision: "1", complete: false, errors: 1 },
				loading: false,
				pages: {
					[sessionCatalogPageKey({ cwd: remoteCwd, archived: false })]: {
						...result(),
						query: { cwd: remoteCwd, archived: false },
						loading: false,
					},
				},
			},
		},
	}));
	api.querySessionCatalog.mockImplementation(async ({ query }) =>
		result({ diagnostics: { errors: query.cwd === cwd ? 1 : 0, reasons: {} } }),
	);
	await act(async () => {
		useUiPreferencesStore.setState({ expandedGroups: [cwd, "/healthy", remoteCwd] });
		root.render(<Sidebar />);
	});
	expect(host.textContent?.match(/sidebar.catalogIssues/g)).toHaveLength(1);
	expect(host.textContent?.match(/sidebar.catalogOffline/g)).toHaveLength(1);
	expect(host.textContent?.match(/sidebar.catalogPartial/g)).toHaveLength(1);
	expect(api.querySessionCatalog.mock.calls.every(([input]) => input.query.cwd !== remoteCwd)).toBe(true);
	await render(false);
	expect(host.textContent).not.toMatch(/sidebar.catalog(Issues|Offline|Updating|Loading|Retry|Partial)/);
});

it("重试绑定当前项目并真实请求重扫，成功后不保留一次性参数", async () => {
	await render(true);
	api.querySessionCatalog.mockResolvedValue(
		result({ complete: true, errors: 0, diagnostics: { errors: 0, reasons: {} } }),
	);
	const retry = [...host.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("sidebar.catalogIssues"),
	);
	if (!retry) throw new Error("Missing retry action");
	await act(async () => retry.click());
	expect(api.querySessionCatalog).toHaveBeenLastCalledWith({
		query: { cwd, archived: false, limit: 6, refresh: true },
	});
	expect(current()?.query.refresh).toBeUndefined();
	expect(host.textContent).not.toContain("sidebar.catalogIssues");
});

it.each([500, 2100])("请求耗时 %i 毫秒时仅在超过两秒后显示加载状态，结束即隐藏", async (duration) => {
	let finish: (page: SessionCatalogPage) => void = () => {
		throw new Error("Request did not start");
	};
	api.querySessionCatalog.mockReturnValue(
		new Promise<SessionCatalogPage>((resolve) => {
			finish = resolve;
		}),
	);
	await render(true);
	expect(current()?.loadingStartedAt).toBeDefined();
	expect(host.textContent).not.toContain("sidebar.catalogLoading");
	expect(host.textContent).not.toContain("sidebar.noSessions");
	await act(() => vi.advanceTimersByTime(duration));
	expect(host.textContent?.includes("sidebar.catalogLoading")).toBe(duration >= 2000);
	await act(async () =>
		finish(result({ complete: true, errors: 0, diagnostics: { errors: 0, reasons: {} } })),
	);
	await act(() => vi.advanceTimersByTime(3000));
	expect(host.textContent).not.toContain("sidebar.catalogLoading");
	expect(host.textContent).toContain("sidebar.noSessions");
});

it("旧环境的不完整结果使用中性说明，不伪装为后台仍在工作", async () => {
	api.querySessionCatalog.mockResolvedValue(result({ scan: undefined, diagnostics: undefined }));
	await render(true);
	expect(host.textContent).toContain("sidebar.catalogPartial");
	expect(host.textContent).not.toContain("sidebar.catalogUpdating");
	expect(host.textContent).not.toContain("sidebar.catalogIssues");
});
