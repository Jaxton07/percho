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
import { expect, test } from "vitest";
import { makeChannelsExtension } from "../src/tools/channels/extension";
import { ChannelService } from "../src/tools/channels/service";

const model: Model<"openai-completions"> = {
	id: "offline",
	name: "offline",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("real SDK sends optional unread projection with matching tools without persisting it", async () => {
	const base = resolve("../../.local/tmp/channels-sdk");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "case-"));
	const cwd = join(root, "project"),
		agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const service = new ChannelService({ projectRoot: cwd, agentDir });
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const manager = SessionManager.create(cwd, join(root, "sessions"));
		const id = manager.getSessionId();
		await service.manage({ sessionId: id }, { action: "create", topic: "work" });
		await service.manage({ sessionId: "other" }, { action: "subscribe", topic: "work" });
		await service.post({ sessionId: "other" }, "work", "hello", "post-1");
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		let starts = 0;
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
					},
				},
			],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			settingsManager,
			resourceLoader,
			noTools: "builtin",
			sessionManager: manager,
			modelRuntime: {
				getModel: () => model,
				hasConfiguredAuth: () => true,
				checkAuth: async () => ({ type: "api_key", key: "test" }),
				getAuth: async () => undefined,
			} as unknown as ModelRuntime,
		}));
		await session.bindExtensions({ mode: "rpc" });
		const requests: unknown[] = [];
		session.agent.streamFunction = async (_model, context) => {
			requests.push(structuredClone(context.messages));
			await service.post({ sessionId: "other" }, "work", "busy", "post-busy");
			expect(starts).toBe(1);
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				stopReason: "stop",
				content: [{ type: "text", text: "done" }],
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		};
		await session.prompt("hello");
		expect(starts).toBe(1);
		const request = JSON.stringify(requests[0]);
		expect(request).toContain("可自行决定是否读取");
		for (const name of ["channel_manage", "channel_post", "channel_read"]) expect(request).toContain(name);
		expect(JSON.stringify(manager.getEntries())).not.toContain("可自行决定是否读取");
		await service.post({ sessionId: "other" }, "work", "idle", "post-idle");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(starts).toBe(1);
		expect(requests).toHaveLength(1);
		expect((await service.read({ sessionId: id }, { topic: "work" }, "read-1")).messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ body: "hello" })]),
		);
		expect(starts).toBe(1);
	} finally {
		session?.dispose();
		await service.close();
		rmSync(root, { recursive: true, force: true });
	}
});
