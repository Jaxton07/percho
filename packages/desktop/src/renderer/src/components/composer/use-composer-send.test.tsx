import { composerDocumentFromText, emptyTranscript } from "@percho/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT, useDraftStore } from "../../stores/drafts";
import { useTranscriptStore } from "../../stores/transcript";
import { useComposerSend } from "./use-composer-send";

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => ({ prompt }) }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/session-event-boundary", () => ({ isSessionSynchronizing: () => false }));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: { getState: () => ({ activeSessionId: "fixture" }) },
}));
vi.mock("../../stores/settings", () => ({ useSettingsStore: { getState: () => ({}) } }));

beforeEach(() => {
	prompt.mockReset().mockResolvedValue(undefined);
	useDraftStore.setState({ bySession: {}, pendingBySession: {}, errorsBySession: {} });
	useTranscriptStore.setState({ bySession: {} });
});

function composer() {
	let actions!: ReturnType<typeof useComposerSend>;
	function Probe() {
		actions = useComposerSend({ draftKey: "fixture", activeSessionId: "fixture", imagesSupported: true });
		return null;
	}
	renderToStaticMarkup(createElement(Probe));
	return actions;
}

describe("compaction recovery send", () => {
	it.each(["paused", "stopped"])(
		"accepts a human correction with a retained queue after %s",
		async (state) => {
			useTranscriptStore.getState().loadHistory("fixture", []);
			useTranscriptStore.setState({
				bySession: {
					fixture: {
						...emptyTranscript(),
						pendingPermissions: [],
						pendingDialogs: [],
						followUpQueue: ["modify config"],
						compactionPause: state === "paused" ? { reason: "failed" } : null,
					},
				},
			});
			useDraftStore.getState().updateDraft("fixture", () => ({
				...EMPTY_DRAFT,
				document: composerDocumentFromText("inspect only"),
			}));
			await composer().handleSend();
			expect(prompt).toHaveBeenCalledExactlyOnceWith({
				sessionId: "fixture",
				text: "inspect only",
				document: undefined,
				images: undefined,
			});
			expect(useTranscriptStore.getState().bySession.fixture?.followUpQueue).toEqual(["modify config"]);
			expect(useDraftStore.getState().bySession.fixture).toBeUndefined();
		},
	);
});
