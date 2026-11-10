// @vitest-environment happy-dom
import { environmentEntityKey } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Translate } from "../../i18n";
import { useToastsStore } from "../../stores/toasts";
import { projectMenuItems } from "./ProjectMenu";
import { ProjectRow } from "./ProjectRow";

const pi = vi.hoisted(() => ({ platform: "darwin", openPath: vi.fn() }));
vi.mock("../../api", () => ({ getPi: () => pi }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../remote/RemoteEnvironmentIndicator", () => ({ RemoteEnvironmentIndicator: () => null }));
const t = ((key: string) => key) as Translate;

beforeEach(() => {
	pi.openPath.mockReset().mockResolvedValue(undefined);
	useToastsStore.setState({ toasts: [] });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
	["darwin", "pathMenu.openFinder", "/projects/我的 项目"],
	["win32", "pathMenu.openExplorer", "C:\\Projects\\My Project"],
	["linux", "pathMenu.openFolder", "/projects/my-project"],
])("%s opens the project itself with platform wording", async (platform, label, cwd) => {
	pi.platform = platform;
	const onTogglePin = vi.fn();
	const onRemove = vi.fn();
	const items = projectMenuItems(t, { cwd, pinned: false, onTogglePin, onRemove });
	expect(items.map((item) => item.key)).toEqual(["pin", "open-directory", "remove"]);
	const [pin, open, remove] = items;
	if (!pin || !open || !remove) throw new Error("Missing project menu actions");
	expect(open.label).toBe(label);
	await open.onSelect();
	expect(pi.openPath).toHaveBeenCalledWith({ target: ".", cwd });
	pin.onSelect();
	remove.onSelect();
	expect(onTogglePin).toHaveBeenCalledOnce();
	expect(onRemove).toHaveBeenCalledOnce();
	expect(items[2]).toMatchObject({ danger: true, separatorBefore: true });
});

it("does not offer native file actions for remote projects or missing directories", () => {
	const remote = environmentEntityKey(
		{ kind: "ssh", connectionId: "test", environmentId: "remote" },
		"/projects/demo",
	);
	for (const cwd of [remote, undefined]) {
		expect(projectMenuItems(t, { cwd, pinned: true, onTogglePin: vi.fn() }).map((item) => item.key)).toEqual([
			"pin",
		]);
	}
	expect(pi.openPath).not.toHaveBeenCalled();
});

it("reports directory-open failures without an unhandled rejection", async () => {
	pi.openPath.mockRejectedValueOnce(new Error("Path not found"));
	const item = projectMenuItems(t, { cwd: "/missing", pinned: false, onTogglePin: vi.fn() }).find(
		(entry) => entry.key === "open-directory",
	);
	if (!item) throw new Error("Missing open-directory action");
	await item.onSelect();
	expect(useToastsStore.getState().toasts).toEqual([
		expect.objectContaining({ titleKey: "toast.directoryOpenFailed", detail: "Path not found" }),
	]);
});

it.each(["project", "daily"] as const)("wires the %s row menu and closes it on selection", async (kind) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(() =>
			root.render(
				<ProjectRow
					label="demo"
					cwd="/projects/demo"
					kind={kind}
					expanded={false}
					onToggle={vi.fn()}
					onNewSession={vi.fn()}
					onTogglePin={vi.fn()}
				/>,
			),
		);
		const more = host.querySelector<HTMLButtonElement>('[aria-label="sidebar.more"]');
		if (!more) throw new Error("Missing project menu button");
		await act(() => more.click());
		const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		expect(items).toHaveLength(kind === "project" ? 2 : 1);
		if (kind === "project") {
			const open = items[1];
			if (!open) throw new Error("Missing open-directory action");
			await act(async () => open.click());
			expect(pi.openPath).toHaveBeenCalledWith({ target: ".", cwd: "/projects/demo" });
			expect(document.querySelector('[role="menuitem"]')).toBeNull();
		}
	} finally {
		await act(() => root.unmount());
		host.remove();
	}
});
