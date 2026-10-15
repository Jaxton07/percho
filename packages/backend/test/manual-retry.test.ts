import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

const MODEL = {
	id: "retry-test",
	name: "retry-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

function response(timestamp: number, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		timestamp,
		stopReason: errorMessage ? "error" : "stop",
		...(errorMessage ? { errorMessage } : {}),
		content: [{ type: "text", text: errorMessage ? "partial" : "完成" }],
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const sessions: AgentSession[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** 真 SDK + 真 session tree/投影/持久化，只替换模型传输；不加载用户配置、不联网。 */
async function fixture(retry = false, manager?: SessionManager) {
	const root = resolve("../../.local/tmp/manual-retry-tests");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(`${root}/case-`);
	dirs.push(dir);
	const sm = manager ?? SessionManager.create(dir, dir);
	if (!manager) {
		sm.appendMessage({ role: "user", timestamp: 1, content: [{ type: "text", text: "修改文件" }] });
		sm.appendMessage({
			...response(2),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts" } }],
		});
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			timestamp: 3,
			isError: false,
			content: [{ type: "text", text: "Successfully edited a.ts" }],
		});
		sm.appendMessage(response(4, "fetch failed"));
	}
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Test assistant",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: MODEL,
		modelRuntime: {
			getModel: () => MODEL,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test-key" }),
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
		sessionManager: sm,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 },
			cacheWarming: "off",
		}),
		resourceLoader,
		noTools: "all",
	});
	sessions.push(session);
	const requests: unknown[] = [];
	let next = 10;
	let outcomes: (string | undefined)[] = [undefined];
	let wait: Promise<void> | undefined;
	session.agent.streamFunction = async (_model, context) => {
		requests.push(structuredClone(context.messages));
		await wait;
		const result = response(next++, outcomes.shift());
		const stream = createAssistantMessageEventStream();
		if (result.stopReason === "error") stream.push({ type: "error", reason: "error", error: result });
		else stream.push({ type: "done", reason: "stop", message: result });
		return stream;
	};
	const events: string[] = [];
	session.subscribe((event) => events.push(event.type));
	const terminal = sm.getBranch().findLast((entry) => entry.type === "message");
	if (!terminal || !session.sessionFile) throw new Error("missing persisted test session");
	return {
		file: session.sessionFile,
		session,
		sm,
		ref: { timestamp: 4, entryId: terminal.id },
		requests,
		events,
		setOutcomes: (values: (string | undefined)[]) => {
			outcomes = values;
		},
		block: (gate: Promise<void>) => {
			wait = gate;
		},
	};
}

function backendFor(session: AgentSession, readOnly = false) {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({ session, readOnly, cwd: process.cwd(), unsubscribe: () => {} });
	return backend;
}

describe("manual retry SDK patch (real offline lifecycle)", () => {
	it("preserves completed tools and raw failure, omits only failed response, adds no user input", async () => {
		const f = await fixture();
		const accepted = vi.fn();
		await f.session.retryLastFailedTurn(f.ref, { preflightResult: accepted });
		expect(accepted).toHaveBeenCalledWith("started");
		expect(f.requests).toHaveLength(1);
		const sent = f.requests[0] as { role: string; timestamp: number; content: unknown }[];
		expect(sent.filter((m) => m.role === "user")).toHaveLength(1);
		expect(
			sent.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("Successfully edited")),
		).toBe(true);
		expect(sent.some((m) => m.timestamp === 4)).toBe(false);
		expect(f.sm.getBranch().filter((e) => e.type === "message" && e.message.role === "user")).toHaveLength(1);
		expect(f.sm.getBranch().some((e) => e.type === "message" && e.message.timestamp === 4)).toBe(true);
		expect(f.sm.getBranch().some((e) => e.type === "context_edit")).toBe(true);
		expect(f.events).toContain("entry_appended");
		expect(f.events).not.toContain("tool_execution_start");
		expect(f.events[0]).toBe("entry_appended");
		expect(f.events.at(-1)).toBe("agent_settled");
		expect(f.session.isIdle).toBe(true);
		const reopened = SessionManager.open(f.file);
		expect(
			reopened.buildSessionContext().messages.some((m) => m.role === "assistant" && m.timestamp === 4),
		).toBe(false);
		await expect(f.session.retryLastFailedTurn(f.ref)).rejects.toThrow("no longer");
	});

	it("continues through SDK auto retry after a manual attempt fails, resetting its budget", async () => {
		const f = await fixture(true);
		f.setOutcomes(["fetch failed", undefined]);
		await f.session.retryLastFailedTurn(f.ref);
		expect(f.requests).toHaveLength(2);
		expect(f.events).toContain("auto_retry_start");
		expect(f.events).toContain("auto_retry_end");
		expect(f.events.filter((e) => e === "agent_settled")).toHaveLength(1);
		expect(f.session.isIdle).toBe(true);
	});

	it("can retry again after exhaustion, including after reopening the persisted session", async () => {
		const f = await fixture(true);
		f.setOutcomes(["fetch failed", "fetch failed"]);
		await f.session.retryLastFailedTurn(f.ref);
		expect(f.requests).toHaveLength(2);
		const last = f.sm.getBranch().findLast((e) => e.type === "message");
		if (last?.type !== "message") throw new Error("missing failure");
		const ref = { entryId: last.id, timestamp: last.message.timestamp };
		const file = f.file;
		f.session.dispose();
		const reopened = await fixture(true, SessionManager.open(file));
		reopened.setOutcomes(["fetch failed", undefined]);
		await reopened.session.retryLastFailedTurn(ref);
		expect(reopened.requests).toHaveLength(2);
		expect(reopened.events).toContain("auto_retry_start");
		expect(JSON.stringify(reopened.requests[0])).toContain("Successfully edited a.ts");
		expect(
			reopened.sm.getBranch().filter((e) => e.type === "message" && e.message.role === "user"),
		).toHaveLength(1);
		expect(reopened.session.isIdle).toBe(true);
	});

	it("backend forwarding adds persisted failure entry identity without mutating SDK message", async () => {
		const f = await fixture();
		const backend = backendFor(f.session);
		const received = vi.fn();
		backend.onEvent(received);
		const raw = f.sm.getBranch().findLast((e) => e.type === "message");
		if (raw?.type !== "message") throw new Error("missing failure");
		const event = { type: "turn_end", message: raw.message, toolResults: [] } as const;
		(backend as unknown as { emitEvent: (id: string, event: unknown) => void }).emitEvent(
			f.session.sessionId,
			event,
		);
		expect(received).toHaveBeenCalledWith(
			f.session.sessionId,
			expect.objectContaining({ retryEntryId: raw.id }),
		);
		expect(event).not.toHaveProperty("retryEntryId");
		expect(raw.message).not.toHaveProperty("entryId");
	});

	it("manual recovery keeps the SDK post-run compaction lifecycle", async () => {
		const f = await fixture();
		await f.session.setModel({ ...MODEL, contextWindow: 24 });
		f.session.settingsManager.setCompactionEnabled(true);
		vi.spyOn(f.session.settingsManager, "getCompactionSettings").mockReturnValue({
			enabled: true,
			reserveTokens: 16,
			keepRecentTokens: 8,
		});
		const ends: unknown[] = [];
		f.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});
		await f.session.retryLastFailedTurn(f.ref);
		expect(f.events).toContain("compaction_start");
		expect(ends).toEqual([
			expect.objectContaining({
				aborted: false,
				result: expect.objectContaining({ summary: expect.any(String) }),
			}),
		]);
		expect(f.sm.getBranch().some((e) => e.type === "compaction")).toBe(true);
		expect(f.events.at(-1)).toBe("agent_settled");
		expect(f.session.isIdle).toBe(true);
	});

	it("abort still settles and releases the run", async () => {
		const f = await fixture();
		let release!: () => void;
		f.block(
			new Promise<void>((r) => {
				release = r;
			}),
		);
		const running = f.session.retryLastFailedTurn(f.ref);
		const aborting = f.session.abort();
		release();
		await Promise.all([running, aborting]);
		expect(f.session.isIdle).toBe(true);
		expect(f.events.at(-1)).toBe("agent_settled");
	});

	it("backend returns on acceptance; a concurrent retry is rejected before another request", async () => {
		const f = await fixture();
		let release!: () => void;
		f.block(
			new Promise<void>((r) => {
				release = r;
			}),
		);
		const backend = backendFor(f.session);
		try {
			await backend.retryLastFailedTurn(f.session.sessionId, f.ref);
			expect(f.session.isStreaming).toBe(true);
			await expect(backend.retryLastFailedTurn(f.session.sessionId, f.ref)).rejects.toThrow("busy");
		} finally {
			release();
			await f.session.waitForIdle();
		}
		expect(f.requests).toHaveLength(1);
	});

	it.each([
		"user",
		"success",
		"aborted",
		"cancel-error",
		"timestamp",
		"entry",
		"missing-entry",
		"same-time-error",
		"compacting",
		"settling",
		"queue",
	])("rejects invalid target / busy: %s, without context edits or request", async (kind) => {
		const f = await fixture();
		if (kind === "user") f.sm.appendMessage({ role: "user", timestamp: 5, content: "new task" });
		if (kind === "success") f.sm.appendMessage(response(5));
		if (kind === "same-time-error") f.sm.appendMessage(response(4, "fetch failed"));
		if (kind === "aborted") f.sm.appendMessage({ ...response(4), stopReason: "aborted" });
		if (kind === "cancel-error") f.sm.appendMessage(response(4, "Request aborted"));
		if (kind === "queue") f.session.agent.followUp("pending");
		if (kind === "compacting") vi.spyOn(f.session, "isCompacting", "get").mockReturnValue(true);
		if (kind === "settling") Object.assign(f.session, { _isEmittingAgentSettled: true });
		const before = f.sm.getBranch().length;
		await expect(
			f.session.retryLastFailedTurn({
				timestamp: kind === "timestamp" ? 999 : 4,
				entryId:
					kind === "entry"
						? "stale"
						: kind === "missing-entry"
							? (undefined as unknown as string)
							: f.ref.entryId,
			}),
		).rejects.toThrow();
		expect(f.sm.getBranch()).toHaveLength(before);
		expect(f.requests).toHaveLength(0);
	});

	it("releases synchronous reservation if durable omission fails", async () => {
		const f = await fixture();
		vi.spyOn(f.sm, "appendContextEdit").mockImplementation(() => {
			throw new Error("disk full");
		});
		await expect(f.session.retryLastFailedTurn(f.ref)).rejects.toThrow("disk full");
		expect(f.session.isIdle).toBe(true);
		expect(f.requests).toHaveLength(0);
	});

	it("backend rejects read-only and missing sessions", async () => {
		const f = await fixture();
		const backend = backendFor(f.session, true);
		await expect(backend.retryLastFailedTurn(f.session.sessionId, f.ref)).rejects.toThrow();
		await expect(backend.retryLastFailedTurn("missing", f.ref)).rejects.toThrow();
		expect(f.requests).toHaveLength(0);
	});
});
