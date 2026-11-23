import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { makeChannelsExtension } from "../src/tools/channels/extension";
import { ChannelService } from "../src/tools/channels/service";

it("启用的真实 SDK 预热不消费频道未读或唤醒会话", async () => {
	const base = resolve(import.meta.dirname, "../../../.local/tmp/channels-warming");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "case-"));
	const cwd = join(root, "project"),
		agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const service = new ChannelService({ projectRoot: cwd, agentDir });
	const model: Model<"openai-completions"> = {
		id: "synthetic",
		name: "synthetic",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		input: ["text"],
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 1024,
		promptCache: { short: 20 },
		cost: { input: 10, output: 1, cacheRead: 1, cacheWrite: 12 },
	};
	const manager = SessionManager.create(cwd, join(root, "sessions"));
	const id = manager.getSessionId();
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		await service.manage({ sessionId: id }, { action: "create", topic: "work" });
		await service.manage({ sessionId: "other" }, { action: "subscribe", topic: "work" });
		await service.post({ sessionId: "other" }, "work", "secret-one", "post-1");
		const settingsManager = SettingsManager.inMemory({
			cacheWarming: "idle",
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		let starts = 0,
			decisions = 0;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				makeChannelsExtension({
					cwd,
					agentDir,
					isEnabled: () => true,
					authorizeRoot: async () => true,
					service: async () => service,
				}),
				{
					name: "counter",
					factory: (pi) => {
						pi.on("before_agent_start", () => {
							starts++;
						});
						pi.on("cache_warming_decision", () => {
							decisions++;
							return { action: "warm" };
						});
					},
				},
			],
		});
		await resourceLoader.reload();
		const calls: { context: unknown; options: unknown }[] = [];
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: 1,
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 100000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const runtime = {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test" }),
			getAuth: async () => undefined,
			streamSimple: (_model: unknown, context: unknown, options: unknown) => {
				calls.push({ context: structuredClone(context), options });
				const stream = createAssistantMessageEventStream();
				if (calls.length === 1) stream.push({ type: "done", reason: "stop", message });
				else void held.then(() => stream.push({ type: "done", reason: "stop", message }));
				return stream;
			},
		};
		vi.useFakeTimers();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			settingsManager,
			resourceLoader,
			sessionManager: manager,
			noTools: "builtin",
			modelRuntime: runtime as unknown as ModelRuntime,
		}));
		await session.bindExtensions({ mode: "rpc" });
		await session.prompt("first");
		expect(starts).toBe(1);
		expect(calls).toHaveLength(1);
		expect(session.cacheWarmingStatus?.state).toBe("scheduled");
		expect(JSON.stringify(calls[0])).toContain("可自行决定是否读取");
		const entriesBefore = JSON.stringify(manager.getEntries());
		expect(entriesBefore).not.toContain("可自行决定是否读取");
		await service.post({ sessionId: "other" }, "work", "secret-two", "post-2");
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toHaveLength(1);
		expect(starts).toBe(1);
		await vi.advanceTimersByTimeAsync(9000);
		expect(decisions).toBe(1);
		expect(calls).toHaveLength(2);
		expect(calls[1].context).toEqual(calls[0].context);
		expect(calls[1].options).toMatchObject({ maxTokens: 1, disableContinuation: true });
		expect(JSON.stringify(calls[1].context)).not.toContain("secret-one");
		expect(session.cacheWarmingStatus?.state).toBe("refreshing");
		expect(starts).toBe(1);
		expect((await service.snapshot(id))[0].unread).toBe(2);
		await service.post({ sessionId: "other" }, "work", "secret-three", "post-3");
		expect(calls).toHaveLength(2);
		expect(starts).toBe(1);
		expect(JSON.stringify(manager.getEntries())).toBe(entriesBefore);
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.getEntries().some((entry) => entry.type === "usage" && entry.kind === "cache_warm")).toBe(
			true,
		);
		expect(JSON.stringify(manager.getEntries())).not.toContain("可自行决定是否读取");
		expect((await service.snapshot(id))[0].unread).toBe(3);
	} finally {
		release();
		session?.dispose();
		vi.useRealTimers();
		await service.close();
		rmSync(root, { recursive: true, force: true });
	}
});
