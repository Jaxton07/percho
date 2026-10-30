import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";
import { createCompactionRequestPolicy } from "../src/tools/compaction-guard/request-policy";
import { decideRequestCompaction } from "../src/tools/compaction-guard/request-trigger";

const model = {
	id: "request-test",
	name: "request-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

function answer(text: string, input = 10, error?: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now() + 1,
		content: [{ type: "text", text }],
		stopReason: error ? "error" : "stop",
		...(error ? { errorMessage: error } : {}),
		usage: {
			input,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const fixtures: { session: AgentSession; dir: string }[] = [];
afterEach(() => {
	for (const { session, dir } of fixtures.splice(0)) {
		session.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

async function fixture(
	options: {
		enabled?: boolean;
		native?: boolean;
		window?: number;
		usage?: number;
		split?: boolean;
		tools?: ToolDefinition[];
		compaction?: NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>["compaction"];
	} = {},
) {
	const root = resolve(import.meta.dirname, "../../../.local/tmp/compaction-request-tests");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(`${root}/case-`);
	const sm = SessionManager.create(dir, dir);
	for (let n = 0; n < 4; n++) {
		sm.appendMessage({
			role: "user",
			timestamp: n * 2 + 1,
			content: [{ type: "text", text: `old ${n} ${"x".repeat(800)}` }],
		});
		sm.appendMessage({
			...answer(options.split ? "old answer ".repeat(100) : `old answer ${n}`, options.usage ?? 170_000),
			timestamp: n * 2 + 2,
		});
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
	const selected = { ...model, contextWindow: options.window ?? model.contextWindow };
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: selected,
		resourceLoader,
		noTools: options.tools ? undefined : "all",
		customTools: options.tools,
		sessionManager: sm,
		modelRuntime: {
			getModel: () => selected,
			getPhysicalModel: () => selected,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test-key" }),
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: options.native ?? true, keepRecentTokens: 50, ...options.compaction },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
	});
	fixtures.push({ session, dir });
	const policy = createCompactionRequestPolicy(dir);
	if (options.enabled !== false) session.setCompactionPolicy(policy);
	const requests: { summary: boolean; messages: unknown[]; model: { id: string; contextWindow: number } }[] =
		[];
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	let summarize: () => Promise<AssistantMessage> = async () => answer("short summary");
	let normal: () => Promise<AssistantMessage> = async () => answer("done");
	session.agent.streamFunction = async (_model, context) => {
		const summary = JSON.stringify(context.messages[0]).includes("context summarization assistant");
		requests.push({
			summary,
			messages: structuredClone(context.messages),
			model: { id: _model.id, contextWindow: _model.contextWindow },
		});
		const result = summary ? await summarize() : await normal();
		const stream = createAssistantMessageEventStream();
		if (result.stopReason === "error" || result.stopReason === "aborted")
			stream.push({ type: "error", reason: result.stopReason, error: result });
		else stream.push({ type: "done", reason: result.stopReason, message: result });
		return stream;
	};
	return {
		session,
		sm,
		policy,
		requests,
		events,
		setSummary: (fn: typeof summarize) => {
			summarize = fn;
		},
		setNormal: (fn: typeof normal) => {
			normal = fn;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function virtualModel() {
	return { ...model, id: "router", api: "pi-virtual" as const, contextWindow: 0 };
}

describe("compaction cross-scenario regressions", () => {
	it("saves input on normal routing failure and allows an ordinary manual retry", async () => {
		const f = await fixture({ usage: 100 });
		const route = vi.fn(async () => {
			throw new Error("401 router authentication failed");
		});
		f.session.modelRuntime.resolveModel = route;
		f.session.modelRuntime.getPhysicalModel = () => undefined;
		await f.session.setModel(virtualModel());
		await f.session.prompt("unique human requirement");
		expect(route).toHaveBeenCalledTimes(1);
		expect(f.requests).toEqual([]);
		expect(f.session.agent.getQueuedMessages()).toEqual([]);
		expect(f.session.isIdle).toBe(true);
		expect(f.session.compactionPause).toBeNull();
		expect(JSON.stringify(f.sm.buildSessionProjection().messages)).toContain("unique human requirement");
		const terminal = f.sm.getBranch().at(-1);
		if (terminal?.type !== "message" || terminal.message.role !== "assistant") throw Error("no failure");
		expect(terminal.message.errorMessage).toBe("401 router authentication failed");
		f.session.modelRuntime.resolveModel = async () => ({ model, thinkingLevel: "off" });
		await f.session.retryLastFailedTurn({ timestamp: terminal.message.timestamp, entryId: terminal.id });
		expect(f.requests).toHaveLength(1);
		expect(JSON.stringify(f.requests[0].messages).split("unique human requirement")).toHaveLength(2);
	});

	it("uses ordinary automatic retry for a transient route failure without duplicating a resumed batch", async () => {
		vi.useFakeTimers();
		try {
			const f = await fixture({ usage: 100 });
			await f.session.abort();
			await f.session.sendUserMessage("older queued instruction", { deliverAs: "followUp" });
			f.session.settingsManager.setRetryEnabled(true);
			const route = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue({
				model,
				thinkingLevel: "off",
			});
			f.session.modelRuntime.resolveModel = route;
			f.session.modelRuntime.getPhysicalModel = () => undefined;
			await f.session.setModel(virtualModel());
			const running = f.session.prompt("newest human correction");
			await vi.runAllTimersAsync();
			await running;
			expect(route).toHaveBeenCalledTimes(2);
			expect(f.requests).toHaveLength(1);
			const text = JSON.stringify(f.requests[0].messages);
			expect(text.split("older queued instruction")).toHaveLength(2);
			expect(text.split("newest human correction")).toHaveLength(2);
			expect(text.indexOf("older queued instruction")).toBeLessThan(text.indexOf("newest human correction"));
			expect(f.session.agent.getQueuedMessages()).toEqual([]);
			expect(f.session.isIdle).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["cancel", "model", "branch"] as const)(
		"retains input without a fake model failure if routing rejects after %s",
		async (operation) => {
			const f = await fixture({ usage: 100 });
			const target = f.sm.getBranch()[1].id;
			const entered = deferred<void>(),
				release = deferred<void>();
			f.session.modelRuntime.resolveModel = async () => {
				entered.resolve();
				await release.promise;
				throw new Error("late route failure");
			};
			await f.session.setModel(virtualModel());
			const running = f.session.prompt("retain rejected route input");
			await entered.promise;
			let stopping: Promise<void> | undefined;
			if (operation === "cancel") stopping = f.session.abort();
			else if (operation === "model") await f.session.setModel(model);
			else {
				f.sm.branch(target);
				f.session.refreshContext();
			}
			release.resolve();
			await running;
			await stopping;
			expect(f.requests).toEqual([]);
			expect(f.events.some((event) => event.type === "message_end")).toBe(false);
			expect(f.session.getFollowUpMessages()).toEqual(["retain rejected route input"]);
			expect(f.session.compactionPause?.reason ?? null).toBe(
				operation === "cancel" ? null : "context-changed",
			);
			expect(f.session.isIdle).toBe(true);
		},
	);

	it.each([false, true])(
		"withdraws published paused inputs before resuming, branch changed: %s",
		async (branch) => {
			const f = await fixture({ usage: 100 });
			const target = f.sm.getBranch()[1].id;
			const prepare = f.session.agent.prepareRequest;
			let change = true;
			f.session.agent.prepareRequest = async (request, signal) => {
				const update = await prepare?.(request, signal);
				if (change) {
					change = false;
					await f.session.setModel({ ...model, contextWindow: 1_000_000 });
				}
				return update;
			};
			await f.session.prompt("withdraw this paused directive");
			expect(f.session.compactionPause?.reason).toBe("context-changed");
			const before = f.sm.getEntries().length;
			if (branch) await f.session.navigateTree(target);
			expect(f.session.clearQueue().followUp).toEqual(["withdraw this paused directive"]);
			const after = f.sm.getEntries().length;
			f.session.clearQueue();
			expect(f.sm.getEntries()).toHaveLength(after);
			if (!branch) expect(after).toBe(before + 1);
			await f.session.prompt("new instruction replaces withdrawn draft");
			const text = JSON.stringify(f.requests.at(-1)?.messages);
			expect(text).not.toContain("withdraw this paused directive");
			expect(text).toContain("new instruction replaces withdrawn draft");
			expect(text).toContain("old 0");
			expect(JSON.stringify(f.sm.getEntries())).toContain("withdraw this paused directive");
			expect(f.session.agent.getQueuedMessages()).toEqual([]);
		},
	);

	it("can retry a model error after idle manual compaction", async () => {
		const f = await fixture({ usage: 100 });
		f.setNormal(async () => answer("", 0, "fetch failed"));
		await f.session.prompt("inspect the project");
		const terminal = f.sm.getBranch().at(-1);
		if (terminal?.type !== "message" || terminal.message.role !== "assistant") throw Error("no failure");
		await f.session.compact();
		f.setNormal(async () => answer("manual recovery success"));
		const before = f.requests.filter((request) => !request.summary).length;
		await f.session.retryLastFailedTurn({ timestamp: terminal.message.timestamp, entryId: terminal.id });
		expect(f.requests.filter((request) => !request.summary)).toHaveLength(before + 1);
		expect(f.session.compactionPause).toBeNull();
		expect(f.session.isIdle).toBe(true);
	});

	it.each(["guard", "sdk", "uninstalled"] as const)(
		"allows native automatic wakeups after idle manual compaction with control disabled: %s",
		async (disabled) => {
			const f = await fixture({
				usage: 100,
				native: disabled !== "sdk",
				enabled: disabled !== "uninstalled",
			});
			if (disabled === "guard") f.policy.enabled = () => false;
			await f.session.compact();
			const before = f.requests.length;
			await f.session.sendUserMessage("automatic native wake", { deliverAs: "followUp" });
			expect(f.requests).toHaveLength(before + 1);
			expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("automatic native wake");
			expect(f.session.agent.getQueuedMessages()).toEqual([]);
		},
	);

	it("does not unfreeze a real user stop through manual compaction", async () => {
		const f = await fixture({ usage: 100 });
		await f.session.abort();
		await f.session.compact();
		const before = f.requests.length;
		await f.session.sendUserMessage("automatic wake after user stop", { deliverAs: "followUp" });
		expect(f.requests).toHaveLength(before);
		expect(f.session.getFollowUpMessages()).toEqual(["automatic wake after user stop"]);
		await f.session.prompt("human resumes after stop");
		expect(f.requests).toHaveLength(before + 1);
		expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("automatic wake after user stop");
	});

	it("rejects an error retry after a real stop without omitting the failed response", async () => {
		const f = await fixture({ usage: 100 });
		f.setNormal(async () => answer("", 0, "fetch failed"));
		await f.session.prompt("failing request");
		const terminal = f.sm.getBranch().at(-1);
		if (terminal?.type !== "message" || terminal.message.role !== "assistant") throw Error("no failure");
		await f.session.abort();
		const before = f.sm.getEntries().length;
		await expect(
			f.session.retryLastFailedTurn({ timestamp: terminal.message.timestamp, entryId: terminal.id }),
		).rejects.toThrow("send a new message");
		expect(f.sm.getEntries()).toHaveLength(before);
		expect(f.requests).toHaveLength(1);
	});
});

describe("request boundary compaction", () => {
	it.each([1_000_000, 200_000, 64_000, 32_000])("takes the earlier trigger at window %i", (window) => {
		const limit = Math.min(Math.ceil(window * 0.8), window - 16_384 + 1);
		const decision = (tokens: number) =>
			decideRequestCompaction({ tokens, contextWindow: window, reserveTokens: 16_384, thresholdPct: 80 });
		expect(decision(limit - 1).trigger).toBe(false);
		expect(decision(limit)).toEqual({ trigger: true, thresholdTokens: limit });
	});

	it("compacts before the first request, keeps the native settings unchanged, and does not compact after completion", async () => {
		const f = await fixture();
		const settings = f.session.settingsManager.getSettings();
		await f.session.prompt("new request");
		expect(f.requests.map((r) => r.summary)).toEqual([true, false]);
		expect(f.events.findIndex((e) => e.type === "compaction_end")).toBeLessThan(
			f.events.findIndex((e) => e.type === "agent_settled"),
		);
		expect(f.session.compactionPause).toBeNull();
		expect(f.session.settingsManager.getSettings()).toEqual(settings);
		expect(f.session.getFollowUpMessages()).toEqual([]);
	});

	it("pauses on a permanent failure without committing partial summaries or consuming inputs; a human message resumes all inputs together", async () => {
		const f = await fixture();
		f.setSummary(async () => answer("", 0, "401 Unauthorized"));
		await f.session.prompt("modify configuration");
		expect(f.session.compactionPause?.reason).toBe("failed");
		expect(f.sm.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(f.session.getFollowUpMessages()).toEqual(["modify configuration"]);
		expect(f.requests.every((r) => r.summary)).toBe(true);
		const calls = f.requests.length;
		await f.session.sendUserMessage("automatic wake", { deliverAs: "followUp" });
		expect(f.requests).toHaveLength(calls);
		f.setSummary(async () => answer("short summary"));
		await f.session.prompt("do not modify, only inspect");
		const request = f.requests.find((r) => !r.summary);
		const serialized = JSON.stringify(request);
		expect(serialized.indexOf("modify configuration")).toBeLessThan(
			serialized.indexOf("do not modify, only inspect"),
		);
		expect(serialized).toContain("automatic wake");
		expect(f.session.getFollowUpMessages()).toEqual([]);
		expect(f.session.compactionPause).toBeNull();
	});

	it.each(["creation", "result"] as const)(
		"retries thrown network faults during %s with exact 2/4/8 second waits",
		async (fault) => {
			const f = await fixture();
			let attempts = 0;
			f.setSummary(async () => {
				attempts++;
				if (fault === "creation") throw new Error("fetch failed");
				return answer("unused summary");
			});
			if (fault === "result") {
				const stream = f.session.agent.streamFunction;
				f.session.agent.streamFunction = async (...args) => {
					const result = await stream(...args);
					result.result = async () => {
						throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
					};
					return result;
				};
			}
			vi.useFakeTimers();
			try {
				const running = f.session.prompt("continue");
				await vi.advanceTimersByTimeAsync(0);
				expect(attempts).toBe(1);
				for (const [index, delay] of [2000, 4000, 8000].entries()) {
					await vi.advanceTimersByTimeAsync(delay - 1);
					expect(attempts).toBe(index + 1);
					await vi.advanceTimersByTimeAsync(1);
					expect(attempts).toBe(index + 2);
				}
				await running;
				expect(f.session.compactionPause?.reason).toBe("failed");
				expect(
					f.events
						.filter((event) => event.type === "summarization_retry_scheduled")
						.map((event) => event.delayMs),
				).toEqual([2000, 4000, 8000]);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("does not auto-compact or pause when the native switch is off", async () => {
		const f = await fixture({ native: false });
		await f.session.prompt("continue");
		expect(f.requests.map((r) => r.summary)).toEqual([false]);
		expect(f.session.compactionPause).toBeNull();
	});

	it("gives each split-summary part its own three retries without restarting the first part", async () => {
		const f = await fixture({ split: true });
		f.policy.retry.baseDelayMs = 1;
		let attempts = 0;
		f.setSummary(async () => {
			attempts++;
			return attempts % 4 === 0 ? answer("short summary") : answer("", 0, "fetch failed");
		});
		await f.session.prompt("continue");
		expect(attempts).toBe(8);
		expect(f.session.compactionPause).toBeNull();
		expect(f.sm.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
		expect(f.requests.filter((r) => !r.summary)).toHaveLength(1);
	});

	it("honors larger original reserves and exact threshold edges without inventing an unknown window", () => {
		expect(
			decideRequestCompaction({
				tokens: 140_000,
				contextWindow: 200_000,
				reserveTokens: 60_000,
				thresholdPct: 80,
			}).trigger,
		).toBe(false);
		expect(
			decideRequestCompaction({
				tokens: 140_001,
				contextWindow: 200_000,
				reserveTokens: 60_000,
				thresholdPct: 80,
			}).trigger,
		).toBe(true);
		expect(
			decideRequestCompaction({
				tokens: 200_000,
				contextWindow: 200_000,
				reserveTokens: 0,
				thresholdPct: 100,
			}).trigger,
		).toBe(true);
		expect(
			decideRequestCompaction({ tokens: 1_000, contextWindow: 0, reserveTokens: 100, thresholdPct: 80 })
				.trigger,
		).toBe(false);
	});

	it.each([false, true])(
		"checks between tool results without repeating the tool, virtual: %s",
		async (virtual) => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "tool result" }],
				details: {},
			}));
			const f = await fixture({
				usage: 100,
				tools: [{ name: "probe", label: "Probe", description: "test", parameters: Type.Object({}), execute }],
			});
			if (virtual) {
				f.session.modelRuntime.resolveModel = async () => ({ model, thinkingLevel: "off" });
				await f.session.setModel(virtualModel());
			}
			let responses = 0;
			f.setNormal(async () => {
				if (responses++ > 0) return answer("finished");
				return {
					...answer("", 170_000),
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }],
				};
			});
			await f.session.prompt("use probe");
			expect(execute).toHaveBeenCalledTimes(1);
			expect(f.requests[0].summary).toBe(false);
			expect(f.requests.at(-1)?.summary).toBe(false);
			expect(f.requests.slice(1, -1).every((r) => r.summary)).toBe(true);
			expect(f.requests.slice(1, -1).length).toBeGreaterThan(0);
			const tool = f.events.findIndex((e) => e.type === "tool_execution_end");
			expect(f.events.findIndex((e) => e.type === "compaction_start")).toBeGreaterThan(tool);
		},
	);

	it("does not commit the first half of a split summary when the second half fails", async () => {
		const f = await fixture({ split: true });
		let parts = 0;
		f.setSummary(async () => (++parts === 1 ? answer("history summary") : answer("", 0, "401 Unauthorized")));
		await f.session.prompt("continue");
		expect(parts).toBe(2);
		expect(f.sm.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(f.session.compactionPause?.reason).toBe("failed");
		expect(f.requests.every((r) => r.summary)).toBe(true);
	});

	it("pauses after one successful compaction if the pending input still exceeds the line", async () => {
		const f = await fixture();
		await f.session.prompt("x".repeat(650_000));
		expect(f.session.compactionPause?.reason).toBe("still-over-threshold");
		expect(f.sm.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(f.requests.every((r) => r.summary)).toBe(true);
		expect(f.session.getFollowUpMessages()[0]).toHaveLength(650_000);
	});

	it("stops during retry backoff without another attempt or settled compaction", async () => {
		const f = await fixture();
		let attempts = 0;
		let stopped: Promise<void> | undefined;
		f.setSummary(async () => {
			attempts++;
			return answer("", 0, "fetch failed");
		});
		f.session.subscribe((event) => {
			if (event.type === "summarization_retry_scheduled") stopped = f.session.abort();
		});
		await f.session.prompt("continue");
		await stopped;
		expect(attempts).toBe(1);
		expect(f.session.isIdle).toBe(true);
		expect(f.sm.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(f.events.filter((e) => e.type === "compaction_start")).toHaveLength(1);
		const count = f.requests.length;
		await f.session.sendUserMessage("automatic wake", { deliverAs: "followUp" });
		expect(f.requests).toHaveLength(count);
		f.setSummary(async () => answer("short summary"));
		await f.session.prompt("resume after stop");
		expect(f.session.compactionPause).toBeNull();
		expect(f.requests.at(-1)?.summary).toBe(false);
	});

	it("routes overflow recovery failures through the same pause, even with queued messages", async () => {
		const f = await fixture({ usage: 100 });
		f.setNormal(async () => {
			f.session.agent.followUp({ role: "user", content: "queued", timestamp: Date.now() });
			return answer("", 0, "Your input exceeds the context window of this model");
		});
		f.setSummary(async () => answer("", 0, "401 Unauthorized"));
		await f.session.prompt("continue");
		expect(f.session.compactionPause?.reason).toBe("failed");
		expect(f.requests.filter((r) => !r.summary)).toHaveLength(1);
		expect(f.session.getFollowUpMessages()).toContain("queued");
	});

	it("does not compact after a completed response even if its reported usage exceeds the window", async () => {
		const f = await fixture({ usage: 100 });
		f.setNormal(async () => answer("complete", 210_000));
		await f.session.prompt("continue");
		expect(f.requests.map((r) => r.summary)).toEqual([false]);
		expect(f.session.compactionPause).toBeNull();
	});

	it("discards a summary if the model changes before commit", async () => {
		const f = await fixture();
		f.setSummary(async () => {
			await f.session.setModel({ ...model, contextWindow: 1_000_000 });
			return answer("summary for old model");
		});
		await f.session.prompt("continue");
		expect(f.sm.getBranch().some((e) => e.type === "compaction")).toBe(false);
		expect(f.session.compactionPause?.reason).toBe("context-changed");
		expect(f.requests.every((r) => r.summary)).toBe(true);
	});

	it("keeps duplicate directives separate across failed recovery attempts", async () => {
		const f = await fixture();
		f.setSummary(async () => answer("", 0, "401 Unauthorized"));
		await f.session.prompt("same directive");
		await f.session.prompt("same directive");
		expect(f.session.getFollowUpMessages()).toEqual(["same directive", "same directive"]);
		f.setSummary(async () => answer("short summary"));
		await f.session.prompt("resume");
		expect(JSON.stringify(f.requests.at(-1)?.messages).match(/same directive/g)).toHaveLength(2);
		expect(f.session.getFollowUpMessages()).toEqual([]);
	});

	it("discards a summary if the branch changes before commit", async () => {
		const f = await fixture();
		const first = f.sm.getBranch()[0].id;
		f.setSummary(async () => {
			f.sm.branch(first);
			return answer("old branch summary");
		});
		await f.session.prompt("continue");
		expect(f.sm.getEntries().some((e) => e.type === "compaction")).toBe(false);
		expect(f.session.compactionPause?.reason).toBe("context-changed");
	});

	it("restores the authoritative pause and queue in both snapshots, and refuses GC", async () => {
		const f = await fixture();
		f.setSummary(async () => answer("", 0, "401 Unauthorized"));
		await f.session.prompt("pending");
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		registry.add({
			session: f.session,
			cwd: f.sm.getCwd(),
			modeRef: { current: "default" },
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
		} as never);
		const count = f.requests.length;
		expect(backend.getLoadedSessions()[0].compactionPause).toEqual(f.session.compactionPause);
		expect(backend.getSessionBaseline(f.session.sessionId).transcript).toMatchObject({
			compactionPause: { reason: "failed" },
			followUpQueue: ["pending"],
		});
		expect(await backend.closeSession(f.session.sessionId, "gc")).toEqual({ closed: false });
		expect(f.requests).toHaveLength(count);
		registry.delete(f.session.sessionId);
		backend.dispose();
	});

	it("includes accepted corrections and attachments during recovery in a single dispatch", async () => {
		const f = await fixture();
		f.setSummary(async () => answer("", 0, "401 Unauthorized"));
		await f.session.prompt("old pending instruction");
		const image = { type: "image" as const, data: "isolated-image-payload", mimeType: "image/png" };
		f.session.agent.followUp({
			role: "user",
			timestamp: Date.now(),
			content: [{ type: "text", text: "attachment" }, image],
		});
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let summaries = 0;
		f.setSummary(async () => {
			summaries++;
			entered();
			await gate;
			return answer("short summary");
		});
		const recovering = f.session.prompt("resume");
		await started;
		await f.session.prompt("latest correction", { streamingBehavior: "followUp" });
		expect(summaries).toBe(1);
		release();
		await recovering;
		expect(f.requests.filter((r) => !r.summary)).toHaveLength(1);
		const text = JSON.stringify(f.requests.at(-1)?.messages);
		expect(text).toContain(image.data);
		expect(text.indexOf("old pending instruction")).toBeLessThan(text.indexOf("resume"));
		expect(text.indexOf("resume")).toBeLessThan(text.indexOf("latest correction"));
		expect(f.session.getFollowUpMessages()).toEqual([]);
	});

	it("reads original settings after save/reload and model switches without retained overrides", async () => {
		const f = await fixture({ usage: 100 });
		const manager = f.session.settingsManager;
		manager.applyOverrides({ compaction: { reserveTokens: 99_000 } });
		manager.setDefaultThinkingLevel("off");
		expect(manager.getCompactionSettings(model).reserveTokens).toBe(16_384);
		await manager.reload();
		expect(manager.getCompactionSettings(model).reserveTokens).toBe(16_384);
		await f.session.setModel({ ...model, contextWindow: 1_000_000 });
		await f.session.prompt("larger window");
		expect(f.requests.map((r) => r.summary)).toEqual([false]);
		expect(manager.getCompactionSettings(model).reserveTokens).toBe(16_384);
		expect(f.policy.retry).toEqual({
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 2000,
			maxAgentDelayMs: 8000,
		});
	});

	it("keeps explicit overflow recovery bounded even if the retried normal request still overflows", async () => {
		const f = await fixture({ usage: 100 });
		f.setNormal(async () => answer("", 0, "Your input exceeds the context window of this model"));
		await f.session.prompt("continue");
		expect(f.requests.filter((r) => !r.summary)).toHaveLength(2);
		expect(f.sm.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
		expect(f.session.compactionPause?.reason).toBe("failed");
	});

	it("does not restore withdrawn queue items when a recovery is interrupted after message publication", async () => {
		const f = await fixture();
		f.setSummary(async () => answer("", 0, "401 Unauthorized"));
		await f.session.prompt("withdraw this directive");
		f.setSummary(async () => answer("short summary"));
		const prepare = f.session.agent.prepareRequest;
		let clear = true;
		f.session.agent.prepareRequest = async (request, signal) => {
			const update = await prepare?.(request, signal);
			if (clear) {
				clear = false;
				f.session.clearQueue();
			}
			return update;
		};
		await f.session.prompt("resume");
		expect(f.requests.every((r) => r.summary)).toBe(true);
		expect(f.session.getFollowUpMessages()).toEqual(["resume"]);
		await f.session.prompt("inspect only");
		expect(f.requests.at(-1)?.summary).toBe(false);
		expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain("withdraw this directive");
	});

	it("checks the dispatch snapshot synchronously after the asynchronous request preparation returns", async () => {
		const f = await fixture({ usage: 100 });
		const prepare = f.session.agent.prepareRequest;
		f.session.agent.prepareRequest = async (request, signal) => {
			const update = await prepare?.(request, signal);
			await f.session.setModel({ ...model, contextWindow: 1_000_000 });
			return update;
		};
		await f.session.prompt("continue");
		expect(f.requests).toEqual([]);
		expect(f.session.compactionPause?.reason).toBe("context-changed");
		expect(f.session.getFollowUpMessages()).toEqual(["continue"]);
	});

	it("retains next-turn and steering custom payloads across a failed preparation", async () => {
		const f = await fixture();
		await f.session.sendCustomMessage(
			{ customType: "fixture", content: "next-turn evidence", display: false, details: { marker: 1 } },
			{ deliverAs: "nextTurn" },
		);
		f.session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "steering evidence" }],
			timestamp: Date.now(),
		});
		f.setSummary(async () => answer("", 0, "401 Unauthorized"));
		await f.session.prompt("pending user");
		expect(f.requests.every((request) => request.summary)).toBe(true);
		f.setSummary(async () => answer("short summary"));
		await f.session.prompt("resume");
		const requests = f.requests.filter((request) => !request.summary);
		expect(requests).toHaveLength(1);
		for (const text of ["next-turn evidence", "steering evidence", "pending user", "resume"]) {
			expect(JSON.stringify(requests[0].messages).split(text)).toHaveLength(2);
		}
		expect(f.session.agent.getQueuedMessages()).toEqual([]);
	});

	it.each(["reload", "dispose"] as const)("rejects a late summary after %s", async (operation) => {
		const f = await fixture();
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.setSummary(async () => {
			entered();
			await gate;
			return answer("late summary");
		});
		const running = f.session.prompt("pending");
		await started;
		if (operation === "reload") await f.session.reload();
		else f.session.dispose();
		release();
		await running;
		expect(f.sm.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(f.requests.filter((request) => !request.summary)).toEqual([]);
	});
	it("keeps custom wakeups after stop frozen without starting or spinning a run", async () => {
		const f = await fixture({ usage: 100 });
		await f.session.prompt("first");
		await f.session.abort();
		let endings = 0;
		// Make a regression fail rather than leave the worker in an unbounded microtask loop.
		const off = f.session.subscribe((event) => {
			if (event.type === "agent_end" && ++endings === 5) void f.session.abort();
		});
		const calls = f.requests.length;
		try {
			await f.session.sendCustomMessage(
				{ customType: "fixture", content: "automatic wake", display: false, details: { marker: 1 } },
				{ triggerTurn: true },
			);
		} finally {
			off();
		}
		expect(endings).toBe(0);
		expect(f.requests).toHaveLength(calls);
		expect(f.session.isIdle).toBe(true);
		expect(f.session.agent.getQueuedMessages()).toMatchObject([{ role: "custom", details: { marker: 1 } }]);
		await f.session.prompt("human resumes");
		expect(f.requests).toHaveLength(calls + 1);
		expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("automatic wake");
		expect(f.session.agent.getQueuedMessages()).toEqual([]);
	});

	it.each([false, true])(
		"reconciles published pending inputs after pause, branch changed: %s",
		async (changeBranch) => {
			const f = await fixture({ usage: 100 });
			const target = f.sm.getBranch()[1].id;
			const prepare = f.session.agent.prepareRequest;
			let change = true;
			f.session.agent.prepareRequest = async (request, signal) => {
				const update = await prepare?.(request, signal);
				if (change) {
					change = false;
					await f.session.setModel({ ...model, contextWindow: 1_000_000 });
				}
				return update;
			};
			await f.session.prompt("retain this directive");
			expect(f.session.compactionPause?.reason).toBe("context-changed");
			const image = { type: "image" as const, data: "isolated-image-data", mimeType: "image/png" };
			f.session.agent.followUp({
				role: "user",
				content: [{ type: "text", text: "retain this directive" }, image],
				timestamp: Date.now(),
			});
			if (changeBranch) await f.session.navigateTree(target);
			await f.session.prompt("latest correction");
			const normal = f.requests.filter((request) => !request.summary);
			expect(normal).toHaveLength(1);
			const text = JSON.stringify(normal[0].messages);
			expect(text.split("retain this directive")).toHaveLength(3);
			expect(text).toContain(image.data);
			expect(text.indexOf("retain this directive")).toBeLessThan(text.indexOf("latest correction"));
			expect(f.session.agent.getQueuedMessages()).toEqual([]);
		},
	);

	it("accepts virtual router state updates and routes each normal request only once", async () => {
		const f = await fixture({ usage: 100 });
		let count = 0;
		const route = vi.fn(async () => ({ model, thinkingLevel: "off" as const, state: { count: ++count } }));
		f.session.modelRuntime.resolveModel = route;
		await f.session.setModel(virtualModel());
		await f.session.prompt("first routed request");
		await f.session.prompt("second routed request");
		expect(f.session.compactionPause).toBeNull();
		expect(f.requests.map((request) => request.summary)).toEqual([false, false]);
		expect(route).toHaveBeenCalledTimes(2);
		expect(f.requests.every((request) => request.model.id === model.id)).toBe(true);
		expect(
			f.sm
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state"),
		).toHaveLength(2);
	});

	it.each([false, true])(
		"uses the routed physical window and model-specific reserves: %s",
		async (override) => {
			const f = await fixture({
				usage: override ? 145_000 : 170_000,
				compaction: override
					? {
							modelOverrides: { "test/request-test": { reserveTokens: 60_000, keepRecentTokens: 100 } },
						}
					: undefined,
			});
			const route = vi.fn(async () => ({ model, thinkingLevel: "off" as const }));
			f.session.modelRuntime.resolveModel = route;
			await f.session.setModel(virtualModel());
			const original = f.session.settingsManager.getSettings();
			const evaluate = vi.spyOn(f.policy, "evaluate");
			await f.session.prompt("routed request over the effective line");
			expect(f.requests.map((request) => request.summary)).toEqual([true, false]);
			expect(evaluate).toHaveBeenCalledWith(
				expect.objectContaining({
					contextWindow: 200_000,
					settings: expect.objectContaining({ reserveTokens: override ? 60_000 : 16_384 }),
				}),
			);
			expect(route).toHaveBeenCalledTimes(2); // normal request + its independent summary
			expect(f.session.settingsManager.getSettings()).toEqual(original);
			expect(f.sm.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		},
	);

	it.each(["cancel", "model", "branch"] as const)(
		"discards a virtual route after %s during routing",
		async (operation) => {
			const f = await fixture({ usage: 100 });
			const target = f.sm.getBranch()[1].id;
			const entered = deferred<void>(),
				release = deferred<void>();
			f.session.modelRuntime.resolveModel = async () => {
				entered.resolve();
				await release.promise;
				return { model, thinkingLevel: "off", state: { stale: true } };
			};
			await f.session.setModel(virtualModel());
			const running = f.session.prompt("pending routed input");
			await entered.promise;
			let stopping: Promise<void> | undefined;
			if (operation === "cancel") stopping = f.session.abort();
			else if (operation === "model") await f.session.setModel({ ...model, contextWindow: 1_000_000 });
			else {
				f.sm.branch(target);
				f.session.refreshContext();
			}
			release.resolve();
			await running;
			await stopping;
			expect(f.requests).toEqual([]);
			expect(f.session.isIdle).toBe(true);
			expect(f.session.compactionPause?.reason ?? null).toBe(
				operation === "cancel" ? null : "context-changed",
			);
			expect(
				f.sm
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state"),
			).toBe(false);
			expect(f.session.getFollowUpMessages()).toContain("pending routed input");
		},
	);

	it.each(["auth", "route"] as const)(
		"shares the per-summary budget across %s preparation and stream failures",
		async (phase) => {
			const f = await fixture();
			let preparations = 0;
			if (phase === "auth") {
				const { streamSimple } = await import("@earendil-works/pi-ai/compat");
				f.session.agent.streamFunction = streamSimple;
				f.session.modelRuntime.getAuth = async () => {
					preparations++;
					throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
				};
			} else {
				f.session.modelRuntime.resolveModel = async (_model, _messages, options) => {
					if (options.reason === "direct") {
						preparations++;
						if (preparations <= 2) throw new Error("fetch failed");
					}
					return { model, thinkingLevel: "off" };
				};
				await f.session.setModel(virtualModel());
				f.setSummary(async () => answer("", 0, "fetch failed"));
			}
			vi.useFakeTimers();
			try {
				const running = f.session.prompt("temporary summary preparation failure");
				await vi.advanceTimersByTimeAsync(0);
				expect(preparations).toBe(1);
				for (const [index, delay] of [2000, 4000, 8000].entries()) {
					await vi.advanceTimersByTimeAsync(delay - 1);
					expect(preparations).toBe(index + 1);
					await vi.advanceTimersByTimeAsync(1);
					expect(preparations).toBe(index + 2);
				}
				await running;
				expect(
					f.events
						.filter((event) => event.type === "summarization_retry_scheduled")
						.map((event) => event.delayMs),
				).toEqual([2000, 4000, 8000]);
				expect(f.session.compactionPause?.reason).toBe("failed");
				if (phase === "route") expect(f.requests.filter((request) => request.summary)).toHaveLength(2);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("retries only the second split part when its summary routing fails", async () => {
		const f = await fixture({ split: true });
		f.policy.retry.baseDelayMs = 1;
		let preparations = 0;
		f.session.modelRuntime.resolveModel = async (_model, _messages, options) => {
			if (options.reason === "direct" && ++preparations > 1 && preparations < 5)
				throw new Error("fetch failed");
			return { model, thinkingLevel: "off" };
		};
		await f.session.setModel(virtualModel());
		await f.session.prompt("split routed summary");
		expect(preparations).toBe(5);
		expect(f.requests.filter((request) => request.summary)).toHaveLength(2);
		expect(f.requests.filter((request) => !request.summary)).toHaveLength(1);
		expect(f.session.compactionPause).toBeNull();
	});

	it.each(["permanent", "cancel"] as const)(
		"does not retry summary preparation after %s",
		async (operation) => {
			const f = await fixture();
			let preparations = 0;
			f.session.modelRuntime.resolveModel = async (_model, _messages, options) => {
				if (options.reason === "direct") {
					preparations++;
					throw new Error(operation === "permanent" ? "401 Unauthorized" : "fetch failed");
				}
				return { model, thinkingLevel: "off" };
			};
			await f.session.setModel(virtualModel());
			let stopping: Promise<void> | undefined;
			if (operation === "cancel")
				f.session.subscribe((event) => {
					if (event.type === "summarization_retry_scheduled") stopping = f.session.abort();
				});
			await f.session.prompt("summary preparation should stop");
			await stopping;
			expect(preparations).toBe(1);
			expect(f.requests).toEqual([]);
			expect(f.session.isIdle).toBe(true);
			expect(f.session.compactionPause?.reason ?? null).toBe(operation === "cancel" ? null : "failed");
		},
	);
	it("checks the physical route after overflow recovery without a second compaction", async () => {
		const f = await fixture({ usage: 100 });
		const reasons: string[] = [];
		f.session.modelRuntime.resolveModel = async (_model, _messages, options) => {
			reasons.push(options.reason);
			return { model, thinkingLevel: "off" };
		};
		await f.session.setModel(virtualModel());
		let normal = 0;
		f.setNormal(async () =>
			normal++ === 0
				? answer("", 0, "Your input exceeds the context window of this model")
				: answer("recovered"),
		);
		await f.session.prompt("overflow routed request");
		expect(f.requests.map((request) => request.summary)).toEqual([false, true, false]);
		expect(reasons).toEqual(["user", "direct", "retry"]);
		expect(f.sm.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(f.session.compactionPause).toBeNull();
	});

	it("does not stream a summary after its slow route ignores cancellation and returns late", async () => {
		const f = await fixture();
		const entered = deferred<void>(),
			release = deferred<void>();
		f.session.modelRuntime.resolveModel = async (_model, _messages, options) => {
			if (options.reason === "direct") {
				entered.resolve();
				await release.promise;
			}
			return { model, thinkingLevel: "off" };
		};
		await f.session.setModel(virtualModel());
		const running = f.session.prompt("summary route cancellation");
		await entered.promise;
		const stopping = f.session.abort();
		release.resolve();
		await running;
		await stopping;
		expect(f.requests).toEqual([]);
		expect(f.events.some((event) => event.type === "summarization_retry_scheduled")).toBe(false);
		expect(f.session.compactionPause).toBeNull();
		expect(f.session.isIdle).toBe(true);
	});
	it.each(["sdk", "guard", "uninstalled"] as const)(
		"keeps virtual routing compatible when host control is disabled: %s",
		async (disabled) => {
			const f = await fixture({ native: disabled !== "sdk", enabled: disabled !== "uninstalled" });
			if (disabled === "guard") f.policy.enabled = () => false;
			const route = vi.fn(async () => ({ model, thinkingLevel: "off" as const, state: { valid: true } }));
			f.session.modelRuntime.resolveModel = route;
			await f.session.setModel(virtualModel());
			await f.session.prompt("native routed request");
			expect(route).toHaveBeenCalledTimes(1);
			expect(f.requests.map((request) => request.summary)).toEqual([false]);
			expect(f.session.compactionPause).toBeNull();
		},
	);
});
