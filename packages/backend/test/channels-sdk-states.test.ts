import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
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

function answer(tool = false): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: tool ? "toolUse" : "stop",
		content: tool
			? [{ type: "toolCall", id: "wait-1", name: "controlled_wait", arguments: {} }]
			: [{ type: "text", text: "provider final" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function fixture(extra?: InlineExtension, firstTool = false) {
	const base = resolve(import.meta.dirname, "../../../.local/tmp/channels-sdk-states");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "case-"));
	const cwd = join(root, "project"),
		agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const service = new ChannelService({ projectRoot: cwd, agentDir });
	const manager = SessionManager.create(cwd, join(root, "sessions"));
	const id = manager.getSessionId();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	let starts = 0;
	const requests: unknown[] = [];
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
			...(extra ? [extra] : []),
		],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			settingsManager,
			resourceLoader,
			sessionManager: manager,
			noTools: "builtin",
			modelRuntime: {
				getModel: () => model,
				hasConfiguredAuth: () => true,
				checkAuth: async () => ({ type: "api_key", key: "test" }),
				getAuth: async () => undefined,
				streamSimple: (_model: unknown, context: unknown) => {
					requests.push(structuredClone(context));
					const message = answer(firstTool && requests.length === 1);
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
					return stream;
				},
			} as unknown as ModelRuntime,
		}));
		await session.bindExtensions({ mode: "rpc" });
		return {
			service,
			manager,
			id,
			session,
			requests,
			starts: () => starts,
			async close() {
				session?.dispose();
				await service.close();
				rmSync(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		session?.dispose();
		await service.close();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

async function createTopic(service: ChannelService, id: string, topic: string, count: number) {
	await service.manage({ sessionId: id }, { action: "create", topic });
	await service.manage({ sessionId: "other" }, { action: "subscribe", topic });
	for (let i = 0; i < count; i++)
		await service.post({ sessionId: "other" }, topic, `secret-body-${topic}-${i}`, `${topic}-${i}`);
}

test("real SDK waits for a running tool before naturally projecting new unread", async () => {
	let entered!: () => void, release!: () => void;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let completed = false,
		aborted = false;
	const extension: InlineExtension = {
		name: "controlled",
		factory: (pi) => {
			pi.registerTool({
				name: "controlled_wait",
				label: "wait",
				description: "Controlled wait",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal) => {
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
						},
						{ once: true },
					);
					entered();
					await held;
					completed = true;
					return { content: [{ type: "text", text: "tool finished" }], details: {} };
				},
			});
		},
	};
	const f = await fixture(extension, true);
	let run: Promise<void> | undefined;
	try {
		await createTopic(f.service, f.id, "work", 0);
		run = f.session.prompt("use the tool");
		await enteredPromise;
		await f.service.post({ sessionId: "other" }, "work", "secret-busy", "busy");
		expect(f.starts()).toBe(1);
		expect(f.requests).toHaveLength(1);
		expect(completed).toBe(false);
		expect(aborted).toBe(false);
		release();
		await run;
		expect(completed).toBe(true);
		expect(aborted).toBe(false);
		expect(f.starts()).toBe(1);
		expect(f.requests).toHaveLength(2);
		expect(JSON.stringify(f.requests[0])).not.toContain("未读频道消息");
		const second = JSON.stringify(f.requests[1]);
		expect(second).toContain('\\"topic\\":\\"work\\",\\"unread\\":1');
		expect(second.indexOf("tool finished")).toBeLessThan(second.indexOf("未读频道消息"));
		expect(second).toContain("tool finished");
		expect(second).not.toContain("secret-busy");
	} finally {
		release();
		await run?.catch(() => {});
		await f.close();
	}
});

test("real SDK request projects exact unread counts for five subscribed channels without bodies", async () => {
	const f = await fixture();
	try {
		for (let i = 1; i <= 5; i++) await createTopic(f.service, f.id, `topic-${i}`, i);
		await f.session.prompt("check channels");
		expect(f.starts()).toBe(1);
		expect(f.requests).toHaveLength(1);
		const request = JSON.stringify(f.requests[0]);
		for (let i = 1; i <= 5; i++) expect(request).toContain(`\\"topic\\":\\"topic-${i}\\",\\"unread\\":${i}`);
		expect(request).not.toContain("secret-body-");
		expect(JSON.stringify(f.manager.getEntries())).not.toContain("未读频道消息");
	} finally {
		await f.close();
	}
});

test("snapshot failure in natural SDK hook is diagnostic only and leaves unread intact", async () => {
	const f = await fixture();
	const error = new Error("synthetic snapshot failure");
	const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await createTopic(f.service, f.id, "work", 1);
		const snapshot = vi.spyOn(f.service, "snapshot").mockRejectedValueOnce(error);
		await f.session.prompt("original prompt");
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(diagnostic).toHaveBeenCalledWith("Channel summary unavailable:", error);
		expect(f.starts()).toBe(1);
		expect(f.requests).toHaveLength(1);
		expect(JSON.stringify(f.requests[0])).toContain("original prompt");
		expect(JSON.stringify(f.requests[0])).not.toContain("未读频道消息");
		expect(JSON.stringify(f.manager.getEntries())).toContain("provider final");
		expect(JSON.stringify(f.manager.getEntries())).not.toContain("未读频道消息");
		expect((await f.service.snapshot(f.id))[0].unread).toBe(1);
	} finally {
		diagnostic.mockRestore();
		await f.close();
	}
});
