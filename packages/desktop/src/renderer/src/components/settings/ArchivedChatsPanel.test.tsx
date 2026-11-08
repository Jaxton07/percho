// @vitest-environment happy-dom
import type { EnvironmentRef } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ArchivedChatsPanel } from "./ArchivedChatsPanel";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	projects: vi.fn(),
	watch: vi.fn(),
	unarchive: vi.fn(),
	environment: { kind: "local" } as EnvironmentRef,
	status: { state: "disconnected" } as { state: string; environment?: EnvironmentRef },
}));
const api = {
	querySessionCatalog: mocks.query,
	querySessionProjects: mocks.projects,
	onSessionCatalogChanged: mocks.watch,
	unarchiveSession: mocks.unarchive,
};
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../environment-context", () => ({ useEnvironment: () => mocks.environment }));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => api }));
vi.mock("../../lib/daily", () => ({ initDailyDir: async () => null }));
vi.mock("../../stores/remote-connection", () => ({
	useRemoteConnectionStore: (selector: (state: object) => unknown) => selector({ status: mocks.status }),
}));
vi.mock("../../stores/projects", () => ({
	useProjectsStore: { getState: () => ({ deleteSession: vi.fn() }) },
}));
vi.mock("../ui/Select", () => ({
	Select: ({
		ariaLabel,
		value,
		onChange,
		options,
	}: {
		ariaLabel: string;
		value: string;
		onChange: (value: string) => void;
		options: { value: string; label: string }[];
	}) => (
		<select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
const page = (name: string, nextCursor?: string) => ({
	sessions: [
		{
			sessionId: name,
			sessionFile: `${name}.jsonl`,
			cwd: "/project",
			name,
			active: false,
			messageCount: 1,
			createdAt: 1,
			archiveRevision: 0,
		},
	],
	revision: "one",
	complete: true,
	errors: 0,
	nextCursor,
});
afterEach(() => {
	vi.resetAllMocks();
	mocks.environment = { kind: "local" };
	mocks.status = { state: "disconnected" };
	vi.unstubAllGlobals();
});
it("搜索加载时保留旧行但禁止操作，失败不冒充空结果", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const pending = deferred<ReturnType<typeof page>>();
	mocks.query.mockResolvedValueOnce(page("known")).mockReturnValueOnce(pending.promise);
	mocks.projects.mockResolvedValue({ projects: [], revision: "one", complete: true, errors: 0 });
	mocks.watch.mockReturnValue(() => {});
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => root.render(<ArchivedChatsPanel />));
	await act(async () => {
		const input = container.querySelector("input");
		if (!input) throw new Error("Missing search input");
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "new");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(container.textContent).toContain("known");
	expect(container.querySelector<HTMLButtonElement>('[aria-label="archive.unarchive"]')?.disabled).toBe(true);
	await act(async () => pending.reject(new Error("offline")));
	expect(container.textContent).toContain("archive.error");
	expect(container.textContent).not.toContain("archive.empty");
	await act(async () => root.unmount());
});

it("环境切换清除筛选并隔离迟到请求和操作", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const remote: EnvironmentRef = { kind: "ssh", connectionId: "c", environmentId: "e" };
	const next = deferred<ReturnType<typeof page>>();
	const operation = deferred<{ archived: boolean }>();
	mocks.query
		.mockResolvedValueOnce(page("old"))
		.mockResolvedValueOnce(page("filtered"))
		.mockReturnValueOnce(next.promise);
	mocks.projects.mockResolvedValue({
		projects: [{ cwd: "/project" }],
		revision: "one",
		complete: true,
		errors: 0,
	});
	const off = vi.fn();
	mocks.watch.mockReturnValue(off);
	mocks.unarchive.mockReturnValue(operation.promise);
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => root.render(<ArchivedChatsPanel />));
	expect(mocks.watch.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
		mocks.query.mock.invocationCallOrder[0] ?? 0,
	);
	await act(async () => {
		const select = container.querySelector<HTMLSelectElement>('[aria-label="archive.project"]');
		if (!select) throw new Error("Missing project select");
		select.value = "/project";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await act(async () =>
		container.querySelector<HTMLButtonElement>('[aria-label="archive.unarchive"]')?.click(),
	);
	mocks.environment = remote;
	mocks.status = { state: "connected", environment: remote };
	await act(async () => root.render(<ArchivedChatsPanel />));
	expect(container.textContent).not.toContain("filtered");
	expect(off).toHaveBeenCalled();
	expect(mocks.query).toHaveBeenLastCalledWith({ query: { archived: true, sort: "archived", limit: 20 } });
	await act(async () => {
		operation.resolve({ archived: true });
		next.resolve(page("remote"));
	});
	expect(container.textContent).toContain("remote");
	expect(container.textContent).not.toContain("archive.operationFailed");
	await act(async () => root.unmount());
});

it("离线缓存、未知、部分和空结果互不混淆", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const remote: EnvironmentRef = { kind: "ssh", connectionId: "c", environmentId: "e" };
	mocks.environment = remote;
	mocks.status = { state: "connected", environment: remote };
	mocks.query.mockResolvedValue({ ...page("partial"), complete: false });
	mocks.projects.mockResolvedValue({ projects: [], revision: "one", complete: true, errors: 0 });
	mocks.watch.mockReturnValue(() => {});
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => root.render(<ArchivedChatsPanel />));
	expect(container.textContent).toContain("archive.partial");
	mocks.status = { state: "disconnected" };
	await act(async () => root.render(<ArchivedChatsPanel />));
	expect(container.textContent).toContain("partial");
	expect(container.querySelector<HTMLButtonElement>('[aria-label="archive.unarchive"]')?.disabled).toBe(true);
	await act(async () => root.unmount());
	const fresh = createRoot(container);
	await act(async () => fresh.render(<ArchivedChatsPanel />));
	expect(container.textContent).toContain("archive.offline");
	expect(container.textContent).not.toContain("archive.empty");
	expect(mocks.query).toHaveBeenCalledTimes(1);
	await act(async () => fresh.unmount());
});

it("请求下一页，并拒绝旧搜索迟到结果", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const old = deferred<ReturnType<typeof page>>();
	mocks.query
		.mockReturnValueOnce(old.promise)
		.mockResolvedValueOnce(page("new", "cursor"))
		.mockResolvedValueOnce(page("more"));
	mocks.projects.mockResolvedValue({ projects: [], revision: "one", complete: true, errors: 0 });
	mocks.watch.mockReturnValue(() => {});
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => {
		root.render(<ArchivedChatsPanel />);
	});
	const input = container.querySelector("input");
	if (!input) throw new Error("Missing search input");
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, "new");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(container.textContent).toContain("new");
	await act(async () => {
		old.resolve(page("old"));
	});
	expect(container.textContent).not.toContain("old");
	const more = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "sidebar.showMore",
	);
	await act(async () => {
		more?.click();
	});
	expect(mocks.query).toHaveBeenLastCalledWith({
		query: { archived: true, search: "new", sort: "archived", limit: 20, cursor: "cursor" },
	});
	expect(container.textContent).toContain("more");
	await act(async () => root.unmount());
});

it("卸载旧环境后其迟到结果不能覆盖新环境", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const old = deferred<ReturnType<typeof page>>();
	mocks.query.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page("new environment"));
	mocks.projects.mockResolvedValue({ projects: [], revision: "one", complete: true, errors: 0 });
	mocks.watch.mockReturnValue(() => {});
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => {
		root.render(<ArchivedChatsPanel key="old" />);
	});
	await act(async () => {
		root.render(<ArchivedChatsPanel key="new" />);
	});
	await act(async () => {
		old.resolve(page("old environment"));
	});
	expect(container.textContent).toContain("new environment");
	expect(container.textContent).not.toContain("old environment");
	await act(async () => root.unmount());
});

it("取消归档使用修订并留在列表页", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.query.mockResolvedValue(page("archived"));
	mocks.projects.mockResolvedValue({ projects: [], revision: "one", complete: true, errors: 0 });
	mocks.watch.mockReturnValue(() => {});
	mocks.unarchive.mockResolvedValue({ archived: false });
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => {
		root.render(<ArchivedChatsPanel />);
	});
	mocks.query.mockResolvedValue({ sessions: [], revision: "two", complete: true, errors: 0 });
	await act(async () => {
		container.querySelector<HTMLButtonElement>('[aria-label="archive.unarchive"]')?.click();
	});
	expect(mocks.unarchive).toHaveBeenCalledWith({
		sessionId: "archived",
		sessionFile: "archived.jsonl",
		expectedRevision: 0,
	});
	expect(container.textContent).toContain("archive.empty");
	await act(async () => root.unmount());
});
