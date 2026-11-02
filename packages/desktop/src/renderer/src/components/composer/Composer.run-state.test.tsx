// @vitest-environment happy-dom

import type { SessionEvent } from "@percho/shared";
import { composerDocumentFromText, emptyTranscript } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_DRAFT, useDraftStore } from "../../stores/drafts";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { Composer } from "./Composer";
import { getComposerEditor, releaseComposerEditor } from "./editor-host";

const fixture = vi.hoisted(() => ({ prompt: vi.fn(), render: vi.fn() }));
vi.mock("../../i18n", () => ({
	useT: () => {
		fixture.render();
		return (key: string) => key;
	},
}));
vi.mock("../../api", () => ({
	getPi: () => ({ showComposerEditMenu: async () => {}, cancelComposerEditMenu: async () => {} }),
}));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => ({ prompt: fixture.prompt }) }));
vi.mock("../../hooks/use-session-state", () => ({
	useActiveModelInfo: () => undefined,
	useSessionReadOnly: () => false,
}));
vi.mock("../../plugins/RegionHost", () => ({ RegionHost: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./PermissionPicker", () => ({ PermissionPicker: () => null }));
vi.mock("./ContextRing", () => ({ ContextRing: () => null }));
vi.mock("./use-slash-menu", () => ({
	useSlashMenu: () => ({
		slashCommands: [],
		slashOpen: false,
		setSlashDismissed: () => {},
		updateToken: () => {},
		restoreSlashPill: () => {},
		handleKeyDown: () => false,
	}),
}));
vi.mock("./use-at-completion", () => ({
	useAtCompletion: () => ({
		atOpen: false,
		atFiltered: [],
		setAtDismissed: () => {},
		updateToken: () => {},
		handleKeyDown: () => false,
	}),
}));

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(useSessionsStore.getState(), "loadModels").mockResolvedValue(undefined);
	useSessionsStore.setState({ activeSessionId: "fixture", sessions: [], newSessionDraft: null });
	useTranscriptStore.setState({
		bySession: { fixture: { ...emptyTranscript(), pendingPermissions: [], pendingDialogs: [] } },
	});
	useDraftStore.setState({ bySession: {}, pendingBySession: {}, errorsBySession: {}, failedBySession: {} });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	releaseComposerEditor("fixture");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function status(patch: Partial<ReturnType<typeof useTranscriptStore.getState>["bySession"][string]>) {
	await act(() =>
		useTranscriptStore.setState((state) => ({
			bySession: {
				fixture: { ...state.bySession.fixture, ...patch } as ReturnType<
					typeof useTranscriptStore.getState
				>["bySession"][string],
			},
		})),
	);
}
const stop = () => container.querySelector('[aria-label="composer.stop"]');
it("实际输入框跨工具轮、压缩和重试保持运行按钮，最终结束才恢复；正文编辑宿主不重建", async () => {
	await act(() => root.render(<Composer />));
	const editor = getComposerEditor("fixture", EMPTY_DRAFT.document).editor;
	await status({ agentActive: true, phase: "streaming" });
	expect(stop()).not.toBeNull();
	await status({ phase: "idle" });
	expect(stop()).not.toBeNull();
	await status({ compacting: true });
	expect(stop()).not.toBeNull();
	expect(container.textContent).toContain("composer.placeholderCompacting");
	await status({ compacting: false, retrying: { attempt: 1, maxAttempts: 3, delayMs: 100 } });
	expect(stop()).not.toBeNull();
	await act(() =>
		useDraftStore
			.getState()
			.updateDraft("fixture", () => ({ ...EMPTY_DRAFT, document: composerDocumentFromText("queue me") })),
	);
	expect(stop()).toBeNull();
	expect(container.querySelector('[aria-label="composer.send"]')).not.toBeNull();
	await act(() =>
		useDraftStore
			.getState()
			.updateDraft("fixture", () => ({ ...EMPTY_DRAFT, images: [{ data: "AQID", mimeType: "image/png" }] })),
	);
	expect(stop()).toBeNull();
	await act(() => useDraftStore.getState().updateDraft("fixture", () => EMPTY_DRAFT));
	expect(stop()).not.toBeNull();
	expect(getComposerEditor("fixture", EMPTY_DRAFT.document).editor).toBe(editor);
	await status({ agentActive: false, retrying: null, phase: "idle" });
	expect(stop()).toBeNull();
});
it("无关工具更新不重新渲染输入框", async () => {
	await act(() => root.render(<Composer />));
	fixture.render.mockClear();
	await status({ messages: [{ kind: "system", id: "update", text: "synthetic background", timestamp: 0 }] });
	expect(fixture.render).not.toHaveBeenCalled();
});

it.each<[string, SessionEvent]>([
	["正常完成", { type: "agent_end", messages: [], willRetry: false }],
	["最终失败收尾", { type: "agent_settled", aborted: false }],
	["中止", { type: "agent_settled", aborted: true }],
	["压缩暂停", { type: "compaction_pause", pause: { reason: "failed" } }],
])("%s 通过权威事件恢复发送态", async (_label, event) => {
	await act(() => root.render(<Composer />));
	await act(() => useTranscriptStore.getState().applyEvent("fixture", { type: "agent_start" }));
	expect(stop()).not.toBeNull();
	await act(() =>
		useTranscriptStore.getState().applyEvent("fixture", { type: "agent_end", messages: [], willRetry: true }),
	);
	expect(stop()).not.toBeNull();
	await act(() => useTranscriptStore.getState().applyEvent("fixture", event));
	expect(stop()).toBeNull();
});
