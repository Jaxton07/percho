import {
	buildLlmUiError,
	emptyTranscript,
	messagesToUIMessages,
	reduceEvent,
	type SessionEvent,
	type UIMessage,
} from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canRetryError } from "../lib/error-retry";
import { retryFailedTurn } from "./session-retry";
import { useTranscriptStore } from "./transcript";

const { retry, prompt, toast } = vi.hoisted(() => ({ retry: vi.fn(), prompt: vi.fn(), toast: vi.fn() }));
vi.mock("../api", () => ({
	getPi: () => ({ forEnvironment: () => ({ retryLastFailedTurn: retry, prompt }) }),
}));
vi.mock("./toasts", () => ({ pushToast: toast }));

function errorCard(id = "failure", timestamp = 100): UIMessage {
	return {
		kind: "error",
		id,
		text: "",
		timestamp: 999, // 错误卡时间与响应 timestamp 故意不同
		error: { ...buildLlmUiError("fetch failed", 999), retryTarget: { timestamp, entryId: `entry-${id}` } },
	};
}
function seed(messages = [errorCard()]) {
	useTranscriptStore.getState().loadHistory("s", messages);
}
beforeEach(() => {
	useTranscriptStore.setState({ bySession: {} });
	retry.mockReset().mockResolvedValue(undefined);
	prompt.mockReset();
	toast.mockReset();
});

describe("failed turn retry", () => {
	it("sends only failure ref, never re-sends user text, images or skill command", async () => {
		seed([
			{
				kind: "user",
				id: "user",
				timestamp: 1,
				text: "expanded skill",
				sourceText: "/skill:tdd task",
				images: [],
			},
			errorCard(),
		]);
		await retryFailedTurn("s", "failure");
		expect(retry).toHaveBeenCalledExactlyOnceWith({
			sessionId: "s",
			ref: { timestamp: 100, entryId: "entry-failure" },
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(useTranscriptStore.getState().bySession.s?.messages).toHaveLength(2);
	});

	it("reserves synchronously, so repeated clicks or a second card instance cannot send twice", async () => {
		seed();
		let resolve!: () => void;
		retry.mockReturnValue(
			new Promise<void>((r) => {
				resolve = r;
			}),
		);
		const first = retryFailedTurn("s", "failure");
		await retryFailedTurn("s", "failure");
		expect(retry).toHaveBeenCalledOnce();
		expect(canRetryError(useTranscriptStore.getState().bySession.s, "failure")).toBe(false);
		resolve();
		await first;
	});

	it("preflight rejection reports error, releases local reservation and allows retry", async () => {
		seed();
		retry.mockRejectedValueOnce(new Error("busy"));
		await retryFailedTurn("s", "failure");
		expect(toast).toHaveBeenCalledWith("warning", "toast.retryFailed", "busy");
		expect(canRetryError(useTranscriptStore.getState().bySession.s, "failure")).toBe(true);
		await retryFailedTurn("s", "failure");
		expect(retry).toHaveBeenCalledTimes(2);
	});

	it("late rejection cannot clear an actual run or a reopened session", async () => {
		seed();
		let reject!: (error: Error) => void;
		retry.mockReturnValue(
			new Promise<void>((_resolve, r) => {
				reject = r;
			}),
		);
		const pending = retryFailedTurn("s", "failure");
		useTranscriptStore.getState().applyEvent("s", { type: "agent_start" });
		reject(new Error("stale request"));
		await pending;
		expect(useTranscriptStore.getState().bySession.s?.agentActive).toBe(true);
	});

	it("unrelated events during rejection do not leave optimistic active stuck", async () => {
		seed();
		let reject!: (error: Error) => void;
		retry.mockReturnValue(
			new Promise<void>((_resolve, r) => {
				reject = r;
			}),
		);
		const pending = retryFailedTurn("s", "failure");
		useTranscriptStore.getState().applyEvent("s", { type: "queue_update", steering: [], followUp: [] });
		reject(new Error("not accepted"));
		await pending;
		expect(useTranscriptStore.getState().bySession.s?.agentActive).toBe(false);
	});

	it("late rejection cannot clear a reopened instance", async () => {
		seed();
		let reject!: (error: Error) => void;
		retry.mockReturnValue(
			new Promise<void>((_resolve, r) => {
				reject = r;
			}),
		);
		const pending = retryFailedTurn("s", "failure");
		useTranscriptStore.getState().resetSession("s");
		seed();
		useTranscriptStore.getState().markAgentActive("s", true);
		reject(new Error("old instance"));
		await pending;
		expect(useTranscriptStore.getState().bySession.s?.agentActive).toBe(true);
	});

	it("old error is disabled after another task, response or error", async () => {
		for (const later of [
			{ kind: "user", id: "new", timestamp: 2, text: "next", images: [] } as UIMessage,
			{ kind: "assistant", id: "new", timestamp: 2, text: "done", thinking: "", tools: [] } as UIMessage,
			errorCard("new", 200),
		]) {
			seed([errorCard(), later]);
			await retryFailedTurn("s", "failure");
		}
		expect(retry).not.toHaveBeenCalled();
	});

	it("new run consumes old error target even if aborted without visible output", () => {
		seed();
		const store = useTranscriptStore.getState();
		store.applyEvent("s", { type: "agent_start" });
		store.applyEvent("s", { type: "agent_settled", aborted: true });
		expect(canRetryError(useTranscriptStore.getState().bySession.s, "failure")).toBe(false);
		expect(useTranscriptStore.getState().bySession.s?.messages[0]).toMatchObject({ kind: "error" });
	});

	it.each([
		{ agentActive: true },
		{ phase: "streaming" as const },
		{ compacting: true },
		{ followUpQueue: ["queued"] },
		{ retrying: { attempt: 1, maxAttempts: 2, delayMs: 1 } },
	])("disables retry while busy: %j", (busy) => {
		expect(canRetryError({ ...emptyTranscript(), messages: [errorCard()], ...busy }, "failure")).toBe(false);
	});

	it("legacy/missing target and stream-guard cards cannot submit an unsafe retry", async () => {
		const card = errorCard();
		if (card.kind === "error") delete card.error.retryTarget;
		seed([card]);
		await retryFailedTurn("s", "failure");
		expect(retry).not.toHaveBeenCalled();
	});

	it("live and replay cards carry original assistant identity, not card creation time", () => {
		const live = reduceEvent(
			reduceEvent(emptyTranscript(), {
				type: "turn_end",
				message: { role: "assistant", timestamp: 123, stopReason: "error", errorMessage: "fetch failed" },
				toolResults: [],
				retryEntryId: "entry-1",
			} as unknown as SessionEvent),
			{ type: "agent_end", messages: [], willRetry: false },
		);
		const liveCard = live.messages.find((message) => message.kind === "error");
		expect(liveCard?.kind === "error" && liveCard.error.retryTarget).toEqual({
			timestamp: 123,
			entryId: "entry-1",
		});
		const replay = messagesToUIMessages([
			{
				role: "assistant",
				timestamp: 123,
				entryId: "entry-1",
				stopReason: "error",
				errorMessage: "fetch failed",
				text: "",
				thinking: "",
				tools: [],
				images: [],
			},
		]);
		const replayCard = replay.find((message) => message.kind === "error");
		expect(replayCard?.kind === "error" && replayCard.error.retryTarget).toEqual({
			timestamp: 123,
			entryId: "entry-1",
		});
	});
});
