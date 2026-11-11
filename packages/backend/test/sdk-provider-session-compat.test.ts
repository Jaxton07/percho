import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupSessionResources, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

const model: Model<"anthropic-messages"> = {
	id: "synthetic",
	name: "synthetic",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};

it("公开预热不会改写 Anthropic 主会话 thread", async () => {
	const base = resolve("../../.local/tmp/sdk-provider-session");
	mkdirSync(base, { recursive: true });
	const cwd = mkdtempSync(join(base, "warm-"));
	const warmModel = {
		...model,
		promptCache: { short: 20 },
		cost: { input: 10, output: 1, cacheRead: 1, cacheWrite: 12 },
	};
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "idle",
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const manager = SessionManager.inMemory(cwd);
	const requests: { sessionId?: string; disableContinuation?: boolean; body: Record<string, any> }[] = [];
	const runtime = {
		getModel: () => warmModel,
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test" }),
		getAuth: async () => undefined,
		streamSimple: (
			requested: typeof warmModel,
			context: Parameters<typeof streamSimple>[1],
			options: Parameters<typeof streamSimple>[2],
		) =>
			streamSimple(requested, context, {
				...options,
				apiKey: "test",
				fetch: async (_input, init) => {
					requests.push({
						sessionId: options?.sessionId,
						disableContinuation: options?.disableContinuation,
						body: JSON.parse(String(init?.body)),
					});
					const events = [
						{
							type: "message_start",
							message: {
								id: `reply-${requests.length}`,
								model: "synthetic",
								usage: { input_tokens: 100000, output_tokens: 0 },
							},
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
						{ type: "message_stop" },
					];
					return new Response(
						events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			}),
	};
	vi.useFakeTimers();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: warmModel,
		settingsManager,
		resourceLoader,
		sessionManager: manager,
		noTools: true,
		modelRuntime: runtime as unknown as ModelRuntime,
	});
	try {
		await session.prompt("first");
		expect(session.cacheWarmingStatus?.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(10000);
		expect(requests).toHaveLength(2);
		expect(requests[0].sessionId).toBe(manager.getSessionId());
		expect(requests[0].body.thread.type).toBe("create");
		// SDK 1.5.1 复用 sessionId，通过 disableContinuation 禁用 thread 而非换 id。
		expect(requests[1].sessionId).toBe(requests[0].sessionId);
		expect(requests[1].disableContinuation).toBe(true);
		expect(requests[1].body.thread).toBeUndefined();
		expect(manager.getEntries().some((entry) => entry.type === "usage" && entry.kind === "cache_warm")).toBe(
			true,
		);
		await session.prompt("second");
		expect(requests[2].body.thread.type).toBe("continue");
	} finally {
		session.dispose();
		cleanupSessionResources();
		vi.useRealTimers();
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("真实会话压缩及撤回后的投影在 Anthropic 请求中完整重建", async () => {
	const base = resolve("../../.local/tmp/sdk-provider-session");
	mkdirSync(base, { recursive: true });
	const cwd = mkdtempSync(join(base, "run-"));
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		settingsManager,
		resourceLoader,
		sessionManager: manager,
		tools: ["read", "grep"],
		modelRuntime: {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test" }),
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
	});
	const bodies: Record<string, any>[] = [];
	session.agent.streamFunction = async (requested, context, options) =>
		streamSimple(requested as typeof model, context, {
			...options,
			apiKey: "test",
			fetch: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				const events = [
					{
						type: "message_start",
						message: {
							id: `reply-${bodies.length}`,
							model: "synthetic",
							usage: { input_tokens: 3, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				];
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
	try {
		session.setActiveToolsByName(["read"]);
		await session.prompt("first");
		await session.prompt("second");
		expect(bodies[1].thread.type).toBe("continue");
		const first = manager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!first) throw new Error("missing user entry");
		manager.appendCompaction("fixture summary", first.id, 100);
		session.refreshContext();
		await session.prompt("after compression");
		expect(bodies[2].thread.type).toBe("create");
		expect(JSON.stringify(bodies[2].messages)).toContain("fixture summary");
		manager.branch(first.id);
		session.refreshContext();
		await session.prompt("replacement");
		expect(bodies[3].thread.type).toBe("create");
		expect(JSON.stringify(bodies[3].messages)).not.toContain("after compression");
		expect(JSON.stringify(bodies[3].messages)).toContain("replacement");
		session.setActiveToolsByName(["read", "grep"]);
		await session.prompt("changed tools");
		expect(bodies[4].thread.type).toBe("create");
		expect(JSON.stringify(bodies[4].tools)).toContain("grep");
		expect(JSON.stringify(bodies[4].messages)).toContain("replacement");
	} finally {
		session.dispose();
		cleanupSessionResources();
		rmSync(cwd, { recursive: true, force: true });
	}
});
