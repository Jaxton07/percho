import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
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

it.each(["openai-completions", "anthropic-messages"] as const)(
	"频道投影经真实 %s 转换且不泄露正文",
	async (api) => {
		const base = resolve(import.meta.dirname, "../../../.local/tmp/channels-provider");
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "case-"));
		const cwd = join(root, "project"),
			agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const service = new ChannelService({ projectRoot: cwd, agentDir });
		const model = {
			id: "synthetic",
			name: "synthetic",
			api,
			provider: api === "anthropic-messages" ? "anthropic" : "test",
			baseUrl: "https://example.invalid",
			input: ["text"],
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} as Model<typeof api>;
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const manager = SessionManager.create(cwd, join(root, "sessions"));
		const id = manager.getSessionId();
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await service.manage({ sessionId: id }, { action: "create", topic: "work" });
			await service.manage({ sessionId: "other" }, { action: "subscribe", topic: "work" });
			await service.post({ sessionId: "other" }, "work", "SECRET_CHANNEL_BODY", "post-1");
			manager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
			manager.appendMessage({
				role: "assistant",
				api,
				provider: model.provider,
				model: model.id,
				timestamp: 2,
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "call_123", name: "channel_read", arguments: { topic: "work" } }],
				usage,
			} as AssistantMessage);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "channel_read",
				isError: false,
				timestamp: 3,
				content: [{ type: "text", text: "old result" }],
			});
			manager.appendMessage({
				role: "assistant",
				api,
				provider: model.provider,
				model: model.id,
				timestamp: 4,
				stopReason: "stop",
				content: [{ type: "text", text: "old answer" }],
				usage,
			} as AssistantMessage);
			const settingsManager = SettingsManager.inMemory({
				cacheWarming: "off",
				compaction: { enabled: false },
				retry: { enabled: false },
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
			const bodies: Record<string, any>[] = [];
			const forbiddenNetwork = vi.fn(async () => {
				throw new Error("network forbidden");
			});
			session.agent.streamFunction = async (_model, context, options) => {
				const opts = {
					...options,
					apiKey: "test",
					fetch: forbiddenNetwork,
					onPayload: (body: unknown) => {
						bodies.push(structuredClone(body) as Record<string, any>);
						throw new Error("CAPTURE_ONLY");
					},
				};
				return api === "openai-completions"
					? openaiStream(model as Model<"openai-completions">, context, opts)
					: anthropicStream(model as Model<"anthropic-messages">, context, opts);
			};
			await session.prompt("next");
			expect(starts).toBe(1);
			expect(bodies).toHaveLength(1);
			expect(forbiddenNetwork).not.toHaveBeenCalled();
			const body = bodies[0];
			const encoded = JSON.stringify(body);
			expect(encoded).toContain("可自行决定是否读取");
			expect(encoded).not.toContain("SECRET_CHANNEL_BODY");
			expect(JSON.stringify(manager.getEntries())).not.toContain("可自行决定是否读取");
			const messages = body.messages as Array<Record<string, any>>;
			if (api === "openai-completions") {
				const call = messages.find((m) => m.tool_calls)?.tool_calls[0];
				const result = messages.find((m) => m.role === "tool");
				expect(call.id).toBe("call_123");
				expect(result?.tool_call_id).toBe(call.id);
				expect(messages.findIndex((m) => m.role === "tool")).toBe(
					messages.findIndex((m) => m.tool_calls) + 1,
				);
				expect(
					messages.every((m) => ["system", "user", "assistant", "tool", "developer"].includes(m.role)),
				).toBe(true);
			} else {
				const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
				const call = blocks.find((b) => b.type === "tool_use");
				const result = blocks.find((b) => b.type === "tool_result");
				expect(call?.id).toBe("call_123");
				expect(result?.tool_use_id).toBe(call.id);
				const callIndex = messages.findIndex((m) => Array.isArray(m.content) && m.content.includes(call));
				const resultIndex = messages.findIndex((m) => Array.isArray(m.content) && m.content.includes(result));
				expect(messages[callIndex].role).toBe("assistant");
				expect(resultIndex).toBe(callIndex + 1);
				expect(messages[resultIndex].role).toBe("user");
				expect(messages.every((m) => ["user", "assistant"].includes(m.role))).toBe(true);
			}
			expect((await service.snapshot(id))[0].unread).toBe(1);
		} finally {
			session?.dispose();
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
