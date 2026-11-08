// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectSection } from "./ProjectSection";

const api = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("../../environment-api", () => ({
	getExecutionApi: () => ({ previewSessionProjectDeletion: api.preview }),
}));
vi.mock("../../i18n", () => ({
	useT: () => (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`,
}));
vi.mock("./SidebarGroup", () => ({
	SidebarGroup: ({ onRemove }: { onRemove: () => void }) => (
		<button type="button" onClick={onRemove}>
			remove
		</button>
	),
}));

it("previews classified counts and forwards only the confirmed token; failures can be retried", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const remove = vi.fn().mockResolvedValue(undefined);
	const props = {
		projects: [{ cwd: "/p", label: "P", pinned: false, totalSessions: 99 }],
		activeSessionId: null,
		batching: {} as never,
		onTogglePin: vi.fn(),
		onRemoveProject: remove,
	} as unknown as Parameters<typeof ProjectSection>[0];
	api.preview
		.mockReset()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ cwd: "/p", token: "token", sessionCount: 7, archivedCount: 2 });
	await act(() => root.render(<ProjectSection {...props} />));
	await act(async () => {
		[...container.querySelectorAll("button")].find((b) => b.textContent === "remove")?.click();
	});
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	expect(container.textContent).toContain("sidebar.removeProjectRetry");
	await act(async () => {
		[...container.querySelectorAll("button")]
			.find((b) => b.textContent?.includes("sidebar.removeProjectRetry"))
			?.click();
	});
	const dialog = document.querySelector('[role="dialog"]')!;
	expect(dialog.textContent).toContain('"count":5,"archived":2');
	expect(dialog.textContent).not.toContain("99");
	await act(async () => {
		[...dialog.querySelectorAll("button")]
			.find((b) => b.textContent?.includes("sidebar.removeProject "))
			?.click();
	});
	expect(remove).toHaveBeenCalledWith("/p", "token");
	await act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it("ignores a preview that finishes after switching sessions", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let resolve!: (value: unknown) => void;
	api.preview.mockReset().mockReturnValue(
		new Promise((r) => {
			resolve = r;
		}),
	);
	const props = {
		projects: [{ cwd: "/p", label: "P", pinned: false }],
		activeSessionId: "one",
		batching: {} as never,
		onTogglePin: vi.fn(),
		onRemoveProject: vi.fn(),
	} as unknown as Parameters<typeof ProjectSection>[0];
	await act(() => root.render(<ProjectSection {...props} />));
	await act(async () => {
		[...container.querySelectorAll("button")].find((b) => b.textContent === "remove")?.click();
	});
	await act(() => root.render(<ProjectSection {...props} activeSessionId="two" />));
	await act(async () => {
		resolve({ cwd: "/p", token: "old", sessionCount: 1, archivedCount: 0 });
	});
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	await act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
