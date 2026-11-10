import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	DefaultResourceLoader,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type ComposerDocument, SESSION_CHANNELS } from "@percho/shared";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeSessionEvent, sanitizeSessionMessage } from "../src/lan/sanitize";
import { makePermissionGateExtension } from "../src/permissions/extension";
import { PiBackend } from "../src/pi-backend";
import { builtinExtensions } from "../src/project/builtin-extensions";
import { RuntimeWriter, readRuntimeFrames } from "../src/runtime/frames";
import {
	bindComposerInputBridge,
	createComposerInputBridge,
	projectComposerMessage,
	skillResourceId,
} from "../src/session/composer-input";
import { prepareMediaFork } from "../src/session/media-fork";
import { SessionMediaStore } from "../src/session/media-store";
import { toBranchSessionMessages } from "../src/session/messages";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";
import { emitSessionShutdown } from "../src/session/shutdown";
import { beginSessionSwitchProbe, finishSessionSwitchProbe } from "../src/session/switch-diagnostics";
import { createCompactionRequestPolicy } from "../src/tools/compaction-guard/request-policy";
import { makeEvapExtension } from "../src/tools/context-evaporation/extension";
import { DEFAULT_EVAP_CONFIG } from "../src/tools/context-evaporation/types";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const backends: PiBackend[] = [];
afterEach(async () => {
	for (const backend of backends.splice(0)) await backend.dispose();
	for (const session of sessions.splice(0)) session.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const model: Model<"openai-completions"> = {
	id: "lifecycle-test",
	name: "lifecycle-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function fixture(
	extension: InlineExtension | ((paths: { agentDir: string; cwd: string }) => InlineExtension[]),
	noTools: "all" | "builtin" = "all",
	providedManager?: SessionManager,
) {
	const fixtureRoot = resolve("../../.local/tmp/sdk-lifecycle");
	mkdirSync(fixtureRoot, { recursive: true });
	const root = mkdtempSync(join(fixtureRoot, "run-"));
	roots.push(root);
	const cwd = providedManager?.getCwd() ?? join(root, "project"),
		agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	mkdirSync(join(cwd, "fixture-skills"), { recursive: true });
	const composer = createComposerInputBridge();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: noTools === "all",
		noSkills: true,
		additionalSkillPaths: [join(cwd, "fixture-skills")],
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			...(typeof extension === "function" ? extension({ agentDir, cwd }) : [extension]),
			composer.extension,
		],
	});
	bindComposerInputBridge(resourceLoader, composer);
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		resourceLoader,
		noTools,
		sessionManager: providedManager ?? SessionManager.create(cwd),
		modelRuntime: {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test-key" }),
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
	});
	sessions.push(session);
	const requests: unknown[] = [];
	const declaredTools: string[][] = [];
	const abortedSignals: boolean[] = [];
	let nextTool: { name: string; arguments: Record<string, unknown> } | undefined;
	let nextFailure: string | undefined;
	session.agent.streamFunction = async (_model, context, options) => {
		const aborted = options?.signal?.aborted === true;
		abortedSignals.push(aborted);
		if (!aborted) requests.push(structuredClone(context.messages));
		if (!aborted)
			declaredTools.push(
				context.messages.flatMap((message) =>
					message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
				),
			);
		const tool = nextTool;
		const failure = nextFailure;
		nextFailure = undefined;
		nextTool = undefined;
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			stopReason: aborted ? "aborted" : failure ? "error" : tool ? "toolUse" : "stop",
			...(failure ? { errorMessage: failure } : {}),
			content: tool
				? [{ type: "toolCall", id: `call-${requests.length}`, ...tool }]
				: [{ type: "text", text: "done" }],
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
		if (failure) stream.push({ type: "error", reason: "error", error: message });
		else if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
		else stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
		return stream;
	};
	return {
		failNextResponse: (message: string) => {
			nextFailure = message;
		},
		composer,
		resourceLoader,
		agentDir,
		cwd,
		session,
		requests,
		declaredTools,
		abortedSignals,
		callTool: async (name: string, args: Record<string, unknown>) => {
			nextTool = { name, arguments: args };
			await session.prompt(`fixture ${name}`);
			return session.messages.findLast((message) => message.role === "toolResult");
		},
	};
}

describe("SDK 1.5.1 real offline run lifecycle", () => {
	it("诊断开关不改变真实SDK模型消息或扩展触发次数", async () => {
		const run = async (enabled: boolean) => {
			let starts = 0;
			if (enabled) beginSessionSwitchProbe();
			try {
				const f = await fixture({
					name: "diagnostic-passive",
					factory: (pi) => {
						pi.on("before_agent_start", () => {
							starts++;
						});
					},
				});
				await f.session.prompt("same synthetic request");
				return {
					starts,
					requests: f.requests.map((request) =>
						(request as { role: string; content: unknown }[]).map(({ role, content }) => ({ role, content })),
					),
				};
			} finally {
				finishSessionSwitchProbe();
			}
		};
		const disabled = await run(false),
			enabled = await run(true);
		expect(enabled).toEqual(disabled);
		expect(enabled.starts).toBe(1);
		expect(enabled.requests).toHaveLength(1);
	});
	it("原字节show_image新写入只持久化私有asset引用；真实provider编码仍只发送轻量文本", async () => {
		let media!: SessionMediaStore, backend!: PiBackend;
		const modeRef = { current: "default" as const };
		const bytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
			"base64",
		);
		const f = await fixture(({ agentDir }) => {
			media = new SessionMediaStore(join(agentDir, "session-media"));
			backend = new PiBackend({
				projectTrust: false,
				permissionGates: false,
				webFetch: false,
				sessionMediaStore: media,
			});
			backends.push(backend);
			const tools = (
				backend as unknown as {
					buildCustomTools(
						gate: unknown,
						builtin: boolean,
						getMode: () => string,
						mode: typeof modeRef,
					): ToolDefinition[];
				}
			).buildCustomTools({}, false, () => "default", modeRef);
			const tool = tools.find((tool) => tool.name === "show_image");
			if (!tool) throw new Error("Missing production show_image");
			return [{ name: "show-assets", factory: (pi) => pi.registerTool(tool) }];
		}, "builtin");
		(backend as unknown as { registry: SessionRegistry }).registry.add({
			session: f.session,
			cwd: f.cwd,
			unsubscribe: () => {},
			gate: { dispose: () => {} } as never,
			dialogs: { dispose: () => {} } as never,
			modeRef,
		});
		writeFileSync(join(f.cwd, "actual.png"), bytes);
		const originalStream = f.session.agent.streamFunction,
			bodies: unknown[] = [];
		const forbiddenNetwork = vi.fn(async () => {
			throw new Error("Network is forbidden in this offline test");
		});
		f.session.agent.streamFunction = async (requested, context, options) => {
			if (
				!context.messages.some(
					(message) => message.role === "toolResult" && message.toolName === "show_image",
				)
			)
				return originalStream(requested, context, options);
			return streamSimple(requested, context, {
				...options,
				apiKey: "synthetic-test-only",
				transport: "sse",
				fetch: forbiddenNetwork,
				onPayload: (payload) => {
					bodies.push(structuredClone(payload));
					throw new Error("CAPTURE_ONLY");
				},
			});
		};
		const result = await f.callTool("show_image", { paths: ["actual.png"] });
		expect(result?.isError).toBe(false);
		if (!result) throw new Error("Missing tool result");
		const reference = (
			result.details as { images: { id: string; revision: string; ownerSessionId: string }[] }
		).images[0];
		if (!reference) throw new Error("Missing asset reference");
		expect(reference.id).toMatch(/^asset:[a-f0-9]{64}$/);
		expect(reference.ownerSessionId).toBe(f.session.sessionId);
		expect((await media.read(f.session.sessionId, reference.id, reference.revision)).data).toBe(
			bytes.toString("base64"),
		);
		expect(readFileSync(f.session.sessionFile as string, "utf8")).not.toContain(bytes.toString("base64"));
		expect(bodies, JSON.stringify(f.session.messages.at(-1))).toHaveLength(1);
		expect(JSON.stringify(bodies)).not.toContain("asset:");
		expect(JSON.stringify(bodies)).not.toContain(bytes.toString("base64"));
		expect(forbiddenNetwork).not.toHaveBeenCalled();
		expect(result?.content.every((block) => block.type === "text")).toBe(true);
		const registeredOwner = (backend as unknown as { registry: SessionRegistry }).registry.get(
			f.session.sessionId,
		);
		if (!registeredOwner) throw new Error("Missing production owner");
		registeredOwner.modeRef = { current: "default" };
		f.session.agent.streamFunction = originalStream;
		const denied = await f.callTool("show_image", { paths: ["actual.png"] });
		expect(denied?.isError).toBe(true);
		expect(JSON.stringify(denied?.content)).toContain("current writable SDK session");
	});
	it("媒体分叉不改变源manager；删源后以分叉owner导出自包含JSONL/HTML，超过4MiB的只读传输可往返", async () => {
		let media!: SessionMediaStore;
		const original = Buffer.alloc(4 * 1024 * 1024, 17);
		const f = await fixture(({ agentDir }) => {
			media = new SessionMediaStore(join(agentDir, "session-media"));
			return [
				{
					name: "asset-fixture",
					factory: (pi) =>
						pi.registerTool({
							name: "show_image",
							label: "show_image",
							description: "Synthetic persisted media",
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => {
								const reference = await media.put(
									media.lease(ctx.sessionManager.getSessionId(), () => true),
									original,
									"image/png",
								);
								return {
									content: [{ type: "text", text: "Image displayed" }],
									details: { images: [reference], paths: [] },
								};
							},
						}),
				},
			];
		}, "builtin");
		await f.callTool("show_image", {});
		const manager = f.session.sessionManager,
			sourceId = manager.getSessionId(),
			file = manager.getSessionFile(),
			leaf = manager.getLeafId();
		if (!file || !leaf) throw new Error("Missing SDK source");
		const before = JSON.stringify([manager.getHeader(), ...manager.getEntries()]),
			beforeFile = readFileSync(file, "utf8");
		const forkFile = await prepareMediaFork(
			manager,
			file,
			leaf,
			media,
			join(dirname(media.rootDirectory), "session-media-forks"),
		);
		expect(manager.getSessionId()).toBe(sourceId);
		expect(manager.getSessionFile()).toBe(file);
		expect(manager.getLeafId()).toBe(leaf);
		expect(JSON.stringify([manager.getHeader(), ...manager.getEntries()])).toBe(before);
		expect(readFileSync(file, "utf8")).toBe(beforeFile);
		const other = await fixture(() => [], "all", SessionManager.open(forkFile));
		const fork = other.session.sessionManager;
		expect(fork.getSessionId()).not.toBe(sourceId);
		expect(fork.getHeader()?.parentSession).toBe(file);
		expect(fork.getEntries().map((entry) => entry.id)).toEqual(manager.getBranch().map((entry) => entry.id));
		// Both registered sources belong to the first backend environment, not the fork runtime's settings.
		vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false, sessionMediaStore: media });
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		for (const item of [f, other])
			registry.add({
				session: item.session,
				cwd: item.cwd,
				unsubscribe: () => {},
				gate: { dispose: () => {} } as never,
				dialogs: { dispose: () => {} } as never,
				modeRef: { current: "default" },
			});
		try {
			await backend.deleteSession(sourceId);
			const messages = await backend.getSessionMessages(fork.getSessionId(), { imageMode: "references" });
			const image = messages.find((message) => message.role === "image")?.images[0];
			if (!image || !("id" in image)) throw new Error("Missing fork image");
			expect(image.ownerSessionId).toBe(fork.getSessionId());
			expect((await backend.getSessionImage(fork.getSessionId(), image.id, image.revision)).data).toBe(
				original.toString("base64"),
			);
			const jsonl = await backend.exportSession(fork.getSessionId(), "jsonl");
			expect(Buffer.byteLength(jsonl)).toBeGreaterThan(4 * 1024 * 1024);
			expect(jsonl).not.toContain("asset:");
			expect(jsonl).toContain(original.toString("base64"));
			const html = await backend.exportSession(fork.getSessionId(), "html");
			const payload = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			if (!payload) throw new Error("Missing HTML data");
			const decoded = Buffer.from(payload, "base64").toString("utf8");
			expect(decoded).not.toContain("asset:");
			expect(decoded).toContain(original.toString("base64"));
			expect(SESSION_CHANNELS.exportSession.operation).toBe("read");
			const persistedTool = fork
				.getEntries()
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "show_image",
				);
			if (persistedTool?.type !== "message" || persistedTool.message.role !== "toolResult")
				throw new Error("Missing persisted fork tool result");
			const persistedReference = (
				persistedTool.message.details as {
					images: { ownerSessionId: string; id: string; revision: string }[];
				}
			).images[0];
			expect(persistedReference?.ownerSessionId).toBe(sourceId);
			// 预算按导出中每次出现计数：同一原图重复引用也会重复序列化base64，不能按摘要去重预算。
			fork.appendMessage({
				role: "toolResult",
				toolCallId: "oversized-export",
				toolName: "show_image",
				content: [{ type: "text", text: "Repeated export images" }],
				details: { images: Array.from({ length: 20 }, () => persistedReference) },
				isError: false,
				timestamp: Date.now(),
			});
			const unchanged = readFileSync(forkFile, "utf8");
			for (const format of ["jsonl", "html"] as const)
				await expect(backend.exportSession(fork.getSessionId(), format)).rejects.toThrow(/budget/);
			expect(readFileSync(forkFile, "utf8")).toBe(unchanged);
			await media.deleteOwner(fork.getSessionId());
			for (const format of ["jsonl", "html"] as const)
				await expect(backend.exportSession(fork.getSessionId(), format)).rejects.toThrow();
			expect(readFileSync(forkFile, "utf8")).toBe(unchanged);
			const stream = new PassThrough(),
				writer = new RuntimeWriter(stream);
			let reader!: ReturnType<typeof readRuntimeFrames>;
			const received = new Promise<unknown>((resolve, reject) => {
				reader = readRuntimeFrames(resolve, reject);
				stream.on("data", reader);
			});
			try {
				writer.write({ type: "response", id: "large-export", result: jsonl });
				expect(await received).toEqual({ type: "response", id: "large-export", result: jsonl });
			} finally {
				writer.dispose();
				reader.dispose();
				stream.destroy();
			}
		} finally {
			await backend.dispose();
		}
	}, 15_000);
	it("host request candidates normalize composer input once, retaining the original input in persisted history", async () => {
		const f = await fixture(() => []);
		f.session.setCompactionPolicy(createCompactionRequestPolicy(f.cwd));
		const document: ComposerDocument = { version: 1, parts: [{ type: "text", text: "original input" }] };
		await f.composer.accept(f.resourceLoader, document, (text) =>
			f.session.prompt(text ?? "", { source: "rpc", expandPromptTemplates: false }),
		);
		expect(f.requests).toHaveLength(1);
		expect(JSON.stringify(f.requests)).toContain("original input");
		expect(JSON.stringify(f.requests)).not.toContain("percho-input-");
		const messages = f.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages)).not.toContain("percho-input-");
		expect(messages[0]).toMatchObject({ message: { perchoInput: document } });
	});
	it("releases handled input and rejects damaged transport before model delivery", async () => {
		let handled = true,
			damage = false;
		const f = await fixture({
			name: "input-boundaries",
			factory: (pi) => {
				pi.on("input", () => (handled ? { action: "handled" } : { action: "continue" }));
				pi.on("message_end", (event) => {
					if (!damage || event.message.role !== "user") return;
					const content = event.message.content;
					const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
					return {
						message: {
							...event.message,
							content: blocks.map((b) =>
								b.type === "text" ? { ...b, text: b.text.replace(/:[a-f0-9]{64}-->/, ":damaged-->") } : b,
							),
						},
					};
				});
			},
		});
		const doc: ComposerDocument = {
			version: 1,
			parts: [
				{ type: "text", text: "readable file " },
				{ type: "file", path: "/fixture/src/file.ts", label: "src/file.ts" },
			],
		};
		const send = () =>
			f.composer.accept(f.resourceLoader, doc, (text) =>
				f.session.prompt(text ?? "", { source: "rpc", expandPromptTemplates: false }),
			);
		await send();
		expect(f.requests).toHaveLength(0);
		expect(f.session.messages).toHaveLength(0);
		handled = false;
		await send();
		expect(f.requests).toHaveLength(1);
		expect(JSON.stringify(f.requests[0])).toContain("@/fixture/src/file.ts");
		damage = true;
		await send();
		expect(f.requests).toHaveLength(1);
		const last = f.session.messages.filter((m) => m.role === "user").at(-1);
		expect(JSON.stringify(last)).toContain("Invalid composer input");
		expect(JSON.stringify(last)).not.toContain("percho-input-");
	});

	it("restores SDK-owned queued documents and images, freezes delivery, and preserves full history after compaction/fork/recall", async () => {
		let file = "";
		const f = await fixture(({ cwd }) => {
			const dir = join(cwd, "fixture-skills", "queued");
			mkdirSync(dir);
			file = join(dir, "SKILL.md");
			writeFileSync(file, "---\nname: queued\ndescription: fixture\n---\nQUEUE_OLD");
			return [];
		});
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		(backend as unknown as { registry: SessionRegistry }).registry.add({
			session: f.session,
			cwd: f.cwd,
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
			modeRef: { current: "default" },
		} as RegisteredSession);
		const document: ComposerDocument = {
			version: 1,
			parts: [
				{ type: "text", text: "queued " },
				{ type: "skill", id: skillResourceId(file), label: "queued" },
			],
		};
		const image = {
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
			mimeType: "image/png",
		};
		const stream = f.session.agent.streamFunction;
		let enter!: () => void, release!: () => void;
		const entering = new Promise<void>((r) => {
				enter = r;
			}),
			gate = new Promise<void>((r) => {
				release = r;
			});
		let first = true;
		f.session.agent.streamFunction = async (...args) => {
			if (first) {
				first = false;
				enter();
				await gate;
			}
			return stream(...args);
		};
		const settled = new Promise<void>((r) => {
			const off = f.session.subscribe((e) => {
				if (e.type === "agent_settled") {
					off();
					r();
				}
			});
		});
		try {
			await backend.prompt(f.session.sessionId, "first");
			await entering;
			await backend.prompt(f.session.sessionId, "ignored", [image, { ...image }], document);
			await f.session.steer("steering", [
				{ type: "image", ...image },
				{ type: "image", ...image },
			]);
			writeFileSync(file, "---\nname: queued\ndescription: fixture\n---\nQUEUE_NEW");
			const mode = f.session.agent.followUpMode;
			const restored = await backend.clearQueue(f.session.sessionId);
			expect(restored.followUpInputs).toEqual([{ document, images: [image, image] }]);
			expect(restored.steeringInputs?.[0].images).toEqual([image, image]);
			expect(restored.followUp).toEqual(["queued queued"]);
			expect(f.session.agent.followUpMode).toBe(mode);
			expect(f.session.agent.hasQueuedMessages()).toBe(false);
			await backend.prompt(f.session.sessionId, "ignored", [image, { ...image }], document);
			rmSync(file);
			release();
			await settled;
			expect(f.requests).toHaveLength(2);
			expect(JSON.stringify(f.requests[1])).toContain("QUEUE_NEW");
			expect(JSON.stringify(f.requests[1])).not.toContain("QUEUE_OLD");
			const sm = f.session.sessionManager;
			const user = sm.getBranch().findLast((e) => e.type === "message" && e.message.role === "user");
			if (user?.type !== "message") throw new Error("missing user");
			sm.appendCompaction("fixture summary", user.id, 100);
			f.session.refreshContext();
			expect(toBranchSessionMessages(sm.getBranch()).filter((m) => m.role === "user")).toHaveLength(2);
			const sourceFile = sm.getSessionFile();
			if (!sourceFile) throw new Error("missing source");
			const branchFile = SessionManager.open(sourceFile).createBranchedSession(user.id);
			if (!branchFile) throw new Error("missing fork");
			expect(toBranchSessionMessages(SessionManager.open(branchFile).getBranch()).at(-1)).toMatchObject({
				document,
			});
			const recalled = await backend.recallMessage(f.session.sessionId, { entryId: user.id });
			expect(recalled).toMatchObject({ document, images: [image, image] });
			await expect(backend.prompt(f.session.sessionId, "ignored", undefined, document)).rejects.toThrow();
			writeFileSync(file, "---\nname: queued\ndescription: fixture\n---\nQUEUE_RESTORED");
			const resent = new Promise<void>((resolve) => {
				const off = f.session.subscribe((event) => {
					if (event.type === "agent_settled") {
						off();
						resolve();
					}
				});
			});
			await backend.prompt(f.session.sessionId, recalled.text, recalled.images, recalled.document);
			await resent;
			const userRequest = (
				f.requests.at(-1) as { role: string; content: { type: string; data?: string }[] }[]
			).findLast((message) => message.role === "user");
			expect(
				userRequest?.content.filter((block) => block.type === "image").map((block) => block.data),
			).toEqual([image.data, image.data]);
			expect(JSON.stringify(f.requests.at(-1))).toContain("QUEUE_RESTORED");
			expect(JSON.stringify(f.requests.at(-1))).not.toContain('"kind":"reference"');
		} finally {
			release();
			await backend.dispose();
		}
	});

	it("recall updates the next real request while retaining the old branch on disk", async () => {
		const f = await fixture(() => []);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		(backend as unknown as { registry: SessionRegistry }).registry.add({
			session: f.session,
			cwd: f.cwd,
			modeRef: { current: "default" },
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
		} as RegisteredSession);
		try {
			await f.session.prompt("earlier request");
			await f.session.prompt("withdrawn unique request");
			const user = f.session.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "message" && entry.message.role === "user");
			if (!user) throw new Error("Missing user entry");
			await backend.recallMessage(f.session.sessionId, { entryId: user.id });
			await f.session.prompt("replacement request");
			const request = JSON.stringify(f.requests.at(-1));
			expect(request).toContain("earlier request");
			expect(request).toContain("replacement request");
			expect(request).not.toContain("withdrawn unique request");
			expect(JSON.stringify(SessionManager.open(f.session.sessionFile as string).getEntries())).toContain(
				"withdrawn unique request",
			);
		} finally {
			await backend.dispose();
		}
	});

	it("applies evaporation to the actual request without changing persisted tool history", async () => {
		const f = await fixture(({ agentDir }) => [
			makeEvapExtension({
				agentDir,
				getConfig: () => ({ ...DEFAULT_EVAP_CONFIG, budgetTokens: 4000, protectionTokens: 100 }),
				reporter: () => {},
			}),
		]);
		const sm = f.session.sessionManager;
		const original = Array.from({ length: 20 }, (_, i) => `${i} ${"a".repeat(30)}`).join("\n");
		sm.appendMessage({ role: "user", content: "read the fixture", timestamp: 1 });
		sm.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: 2,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "fixture.txt" } }],
			usage: {
				input: 3900,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3901,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: original }],
			isError: false,
			timestamp: 3,
		});
		f.session.refreshContext();
		await f.session.bindExtensions({ mode: "rpc" });
		await f.session.prompt(`continue ${"background ".repeat(100)}`);
		expect(JSON.stringify(f.requests[0])).toContain("输出已淘汰");
		expect(JSON.stringify(f.requests[0])).not.toContain(JSON.stringify(original));
		expect(JSON.stringify(sm.getBranch())).toContain(JSON.stringify(original));
		expect(JSON.stringify(SessionManager.open(f.session.sessionFile as string).getBranch())).toContain(
			JSON.stringify(original),
		);
	});

	it("manual retry reuses the accepted skill snapshot without adding a user message or reading the deleted resource", async () => {
		let file = "";
		const f = await fixture(({ cwd }) => {
			const dir = join(cwd, "fixture-skills", "retry");
			mkdirSync(dir);
			file = join(dir, "SKILL.md");
			writeFileSync(file, "---\nname: retry\ndescription: fixture\n---\nRETRY_SNAPSHOT");
			return [];
		});
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		(backend as unknown as { registry: SessionRegistry }).registry.add({
			session: f.session,
			cwd: f.cwd,
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
			modeRef: { current: "default" },
		} as RegisteredSession);
		const document: ComposerDocument = {
			version: 1,
			parts: [{ type: "skill", id: skillResourceId(file), label: "retry" }],
		};
		const settled = () =>
			new Promise<void>((r) => {
				const off = f.session.subscribe((e) => {
					if (e.type === "agent_settled") {
						off();
						r();
					}
				});
			});
		try {
			f.failNextResponse("fixture provider error");
			const first = settled();
			await backend.prompt(f.session.sessionId, "ignored", undefined, document);
			await first;
			rmSync(file);
			const failed = f.session.sessionManager
				.getBranch()
				.findLast((e) => e.type === "message" && e.message.role === "assistant");
			if (failed?.type !== "message") throw new Error("missing failed response");
			const second = settled();
			await backend.retryLastFailedTurn(f.session.sessionId, {
				entryId: failed.id,
				timestamp: failed.message.timestamp,
			});
			await second;
			expect(f.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
			expect(JSON.stringify(f.requests[1])).toContain("RETRY_SNAPSHOT");
			expect(
				toBranchSessionMessages(f.session.sessionManager.getBranch()).find((m) => m.role === "user"),
			).toMatchObject({ document });
		} finally {
			await backend.dispose();
		}
	});
	it("deduplicates by effective resource identity in first-reference order and rejects any invalid reference atomically", async () => {
		const files: Record<string, string> = {};
		const f = await fixture(({ cwd }) => {
			for (const name of ["alpha", "beta"]) {
				const dir = join(cwd, "fixture-skills", name);
				mkdirSync(dir);
				files[name] = join(dir, "SKILL.md");
				writeFileSync(
					files[name],
					`---\nname: ${name}\ndescription: fixture\n---\nSAME_BODY <skill> "quoted"\n`,
				);
			}
			return [];
		});
		const ref = (name: string) => ({ type: "skill" as const, id: skillResourceId(files[name]), label: name });
		const document: ComposerDocument = {
			version: 1,
			parts: [
				{ type: "text", text: "body <skill> literal " },
				ref("beta"),
				{ type: "text", text: "\n" },
				ref("alpha"),
				{ type: "text", text: " then " },
				ref("beta"),
			],
		};
		const send = async (doc: ComposerDocument) => {
			let run: Promise<void> | undefined;
			await f.composer.accept(
				f.resourceLoader,
				doc,
				(text) =>
					new Promise<void>((resolve, reject) => {
						run = f.session.prompt(text ?? "", {
							source: "rpc",
							expandPromptTemplates: false,
							preflightResult: () => resolve(),
						});
						run.then(resolve, reject);
					}),
			);
			await run;
		};
		await expect(
			send({ version: 1, parts: [ref("alpha"), { ...ref("beta"), id: "forged" }] }),
		).rejects.toThrow("unavailable");
		expect(f.session.messages.filter((m) => m.role === "user")).toHaveLength(0);
		await send(document);
		const request = JSON.stringify(f.requests[0]);
		expect(request.match(/SAME_BODY/g)).toHaveLength(2);
		expect(request.indexOf('name=\\"beta')).toBeLessThan(request.indexOf('name=\\"alpha'));
		expect(f.session.messages.filter((m) => m.role === "user")[0]).toMatchObject({ perchoInput: document });
		writeFileSync(files.alpha, "---\nname: replacement\ndescription: fixture\n---\nNEXT_VERSION");
		await f.session.reload();
		await send({ version: 1, parts: [ref("alpha")] });
		expect(JSON.stringify(f.requests.at(-1))).toContain("NEXT_VERSION");
		expect(JSON.stringify(f.requests[0])).not.toContain("NEXT_VERSION");
		writeFileSync(files.alpha, "---\nname: beta\ndescription: conflicting fixture\n---\nOVERRIDE");
		await f.session.reload();
		const effective = f.resourceLoader.getSkills().skills.find((s) => s.name === "beta");
		if (!effective) throw new Error("missing effective skill");
		const shadowed = effective.filePath === files.alpha ? "beta" : "alpha";
		await expect(send({ version: 1, parts: [ref(shadowed)] })).rejects.toThrow("unavailable");
		writeFileSync(files.alpha, "---\nname: alpha\ndescription: fixture\n---\nNEXT_VERSION");
		await f.session.reload();
		rmSync(files.beta);
		const count = f.session.messages.filter((m) => m.role === "user").length;
		await expect(send({ version: 1, parts: [ref("alpha"), ref("beta")] })).rejects.toThrow();
		expect(f.session.messages.filter((m) => m.role === "user")).toHaveLength(count);
	});
	it("isolates asynchronous preflight from concurrent submissions and extension-injected messages, including reload", async () => {
		let skillFile = "";
		let entered!: () => void, release!: () => void;
		const entering = new Promise<void>((r) => {
			entered = r;
		});
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let block = true;
		const f = await fixture(({ cwd }) => {
			const directory = join(cwd, "fixture-skills", "isolated");
			mkdirSync(directory);
			skillFile = join(directory, "SKILL.md");
			writeFileSync(skillFile, "---\nname: isolated\ndescription: fixture\n---\nISOLATED_DEFINITION");
			return [
				{
					name: "async-input",
					factory: (pi) => {
						pi.on("input", async (e) => {
							if (e.source !== "rpc") return { action: "continue" };
							if (block) {
								block = false;
								entered();
								await gate;
								await pi.sendUserMessage("extension injected");
							}
							return { action: "transform", text: `changed ${e.text}` };
						});
					},
				},
			];
		});
		const doc: ComposerDocument = {
			version: 1,
			parts: [{ type: "skill", id: skillResourceId(skillFile), label: "isolated" }],
		};
		const send = async (document: ComposerDocument) => {
			let running: Promise<void> | undefined;
			await f.composer.accept(
				f.resourceLoader,
				document,
				(text) =>
					new Promise<void>((resolve, reject) => {
						running = f.session.prompt(text ?? "", {
							source: "rpc",
							expandPromptTemplates: false,
							streamingBehavior: "followUp",
							preflightResult: () => resolve(),
						});
						running.then(resolve, reject);
					}),
			);
			return { running };
		};
		const settled = new Promise<void>((resolve) => {
			const off = f.session.subscribe((e) => {
				if (e.type === "agent_settled") {
					off();
					resolve();
				}
			});
		});
		const pending = send(doc);
		await entering;
		await expect(send(doc)).rejects.toThrow("still being accepted");
		release();
		const first = await pending;
		await first.running;
		await settled;
		const users = f.session.messages.filter((m) => m.role === "user");
		expect(users[0]).not.toHaveProperty("perchoInput");
		expect(users[1]).toMatchObject({ perchoInput: doc });
		expect(JSON.stringify(f.requests[0])).not.toContain("ISOLATED_DEFINITION");
		await f.session.reload();
		const next = await send(doc);
		await next.running;
		expect(f.session.messages.filter((m) => m.role === "user").at(-1)).toMatchObject({ perchoInput: doc });
		const count = f.session.messages.length;
		await expect(
			send({ version: 1, parts: [{ type: "skill", id: "forged", label: "isolated" }] }),
		).rejects.toThrow("unavailable");
		expect(f.session.messages).toHaveLength(count);
		const retry = await send(doc);
		await retry.running;
		expect(f.session.messages.filter((m) => m.role === "user").at(-1)).toMatchObject({ perchoInput: doc });
	});
	it("accepts inline skill input after external transforms, freezes one definition, and replays/exports safely", async () => {
		let skillFile = "";
		const seen: string[] = [];
		const beforeStart: string[] = [];
		const f = await fixture(({ cwd }) => {
			const directory = join(cwd, "fixture-skills", "test");
			mkdirSync(directory);
			skillFile = join(directory, "SKILL.md");
			writeFileSync(skillFile, "---\nname: test\ndescription: fixture\n---\nUNIQUE_SKILL_DEFINITION");
			return [
				{
					name: "prefix-transform",
					factory: (pi) => {
						pi.on("before_agent_start", (e) => {
							if (e.messageType === "user") beforeStart.push(e.prompt);
						});
						pi.on("input", (e) => {
							seen.push(e.text);
							return e.text.startsWith("?quick ")
								? { action: "transform", text: `Briefly: ${e.text.slice(7)}` }
								: { action: "continue" };
						});
					},
				},
			];
		});
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		registry.add({
			session: f.session,
			cwd: f.cwd,
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
			modeRef: { current: "default" },
		} as RegisteredSession);
		const document: ComposerDocument = {
			version: 1,
			parts: [
				{ type: "text", text: "?quick before " },
				{ type: "skill", id: skillResourceId(skillFile), label: "test" },
				{ type: "text", text: " after " },
				{ type: "skill", id: skillResourceId(skillFile), label: "test" },
			],
		};
		const starts: unknown[] = [];
		const settled = new Promise<void>((resolve) => {
			const off = f.session.subscribe((e) => {
				if (e.type === "message_start" && e.message.role === "user")
					starts.push(projectComposerMessage(e.message));
				if (e.type === "agent_settled") {
					off();
					resolve();
				}
			});
		});
		try {
			await backend.prompt(f.session.sessionId, "ignored renderer text", undefined, document);
			await settled;
			expect(beforeStart[0]).toContain("UNIQUE_SKILL_DEFINITION");
			expect(beforeStart[0]).toContain("<!--percho-input-");
			expect(seen).toEqual(["?quick before test after test"]);
			const request = JSON.stringify(f.requests[0]);
			expect(request).toContain("Briefly: before test after test");
			expect(request.match(/UNIQUE_SKILL_DEFINITION/g)).toHaveLength(1);
			expect(request).not.toContain("<!--percho-input-");
			writeFileSync(skillFile, "MODIFIED");
			const file = f.session.sessionManager.getSessionFile();
			if (!file) throw new Error("missing session");
			const reopened = SessionManager.open(file);
			const messages = toBranchSessionMessages(reopened.getBranch());
			expect(messages[0]).toMatchObject({ role: "user", text: "?quick before test after test", document });
			expect(JSON.stringify(messages)).not.toContain("<!--percho-input-");
			expect(JSON.stringify(starts)).not.toContain("<!--percho-input-");
			expect(JSON.stringify(starts)).not.toContain("UNIQUE_SKILL_DEFINITION");
			expect(JSON.stringify(sanitizeSessionMessage(messages[0]))).not.toContain(skillResourceId(skillFile));
			const start = starts[0] as never;
			expect(JSON.stringify(sanitizeSessionEvent({ type: "message_start", message: start }))).not.toContain(
				"perchoInput",
			);
			const html = await backend.exportSession(f.session.sessionId, "html");
			const payload = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			if (!payload) throw new Error("missing HTML session data");
			const htmlData = Buffer.from(payload, "base64").toString();
			expect(htmlData).not.toContain("UNIQUE_SKILL_DEFINITION");
			expect(htmlData).not.toContain("<!--percho-input-");
			const jsonl = await backend.exportSession(f.session.sessionId, "jsonl");
			expect(jsonl).toContain("UNIQUE_SKILL_DEFINITION");
			expect(jsonl).not.toContain("<!--percho-input-");
		} finally {
			await backend.dispose();
		}
	});
	it("sends plain multiline input unchanged and reopens the persisted user message", async () => {
		const f = await fixture({ name: "plain-composer", factory: () => {} });
		const text = "第一行\n第二行 中文";
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		registry.add({
			session: f.session,
			cwd: f.session.cwd,
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
			modeRef: { current: "default" },
		} as RegisteredSession);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = f.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
			});
		});
		await backend.prompt(f.session.sessionId, text);
		await settled;
		expect(f.requests[0]).toContainEqual(
			expect.objectContaining({ role: "user", content: [{ type: "text", text }] }),
		);
		const file = f.session.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const reopened = SessionManager.open(file);
		expect(reopened.buildSessionContext().messages).toContainEqual(
			expect.objectContaining({ role: "user", content: [{ type: "text", text }] }),
		);
		await backend.dispose();
	});

	it("replaces user transport before the first request and persists metadata on the same message", async () => {
		const original = { version: 1, parts: [{ type: "text", text: "before skill after" }] };
		const f = await fixture({
			name: "composer-seam",
			factory: (pi) => {
				pi.on("message_end", async (event) => {
					if (event.message.role !== "user") return;
					await Promise.resolve();
					return {
						message: {
							...event.message,
							content: [{ type: "text" as const, text: "DEFINITION\nbefore skill after" }],
							perchoInput: original,
						},
					};
				});
			},
		});
		await f.session.prompt("TRANSPORT", { expandPromptTemplates: false });
		expect(JSON.stringify(f.requests[0])).toContain("DEFINITION");
		expect(JSON.stringify(f.requests[0])).not.toContain("TRANSPORT");
		const file = f.session.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const reopened = SessionManager.open(file);
		const user = reopened.buildSessionContext().messages.find((m) => m.role === "user");
		expect(user).toMatchObject({
			perchoInput: original,
			content: [{ type: "text", text: "DEFINITION\nbefore skill after" }],
		});
	});

	it("exposes the transport to input extensions before message_end can restore user semantics", async () => {
		const original = { version: 1, parts: [{ type: "text", text: "?quick explain this skill" }] };
		const transport = JSON.stringify({
			perchoComposer: 1,
			original,
			modelText: "SKILL DEFINITION\n?quick explain this skill",
		});
		const seen: string[] = [];
		const f = await fixture({
			name: "composer-input-seam",
			factory: (pi) => {
				// Same prefix dispatch as the SDK's examples/extensions/input-transform.ts.
				pi.on("input", (event) => {
					seen.push(event.text);
					if (event.text.startsWith("?quick ")) {
						return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };
					}
					return { action: "continue" };
				});
				pi.on("message_end", (event) => {
					if (event.message.role !== "user" || !Array.isArray(event.message.content)) return;
					if (event.message.content[0]?.type !== "text" || event.message.content[0].text !== transport)
						return;
					return {
						message: {
							...event.message,
							content: [{ type: "text" as const, text: "SKILL DEFINITION\n?quick explain this skill" }],
							perchoInput: original,
						},
					};
				});
			},
		});
		await f.session.prompt("?quick explain this skill", { expandPromptTemplates: false });
		await f.session.prompt(transport, { expandPromptTemplates: false });
		expect(seen).toEqual(["?quick explain this skill", transport]);
		const requests = f.requests as Array<Array<{ role: string; content: unknown }>>;
		expect(requests[0].findLast((m) => m.role === "user")?.content).toEqual([
			{ type: "text", text: "Respond briefly: explain this skill" },
		]);
		// This is the design gate's counterexample: replacement succeeds, but dispatch was already skipped.
		expect(requests[1].findLast((m) => m.role === "user")?.content).toEqual([
			{ type: "text", text: "SKILL DEFINITION\n?quick explain this skill" },
		]);
	});

	it("handles user and custom starts without fabricating user messages", async () => {
		const starts: { kind: string; idle: boolean; prompt?: string }[] = [];
		const f = await fixture({
			name: "observe-starts",
			factory: (pi) => {
				pi.on("before_agent_start", (event, ctx) => {
					starts.push({
						kind: event.messageType,
						idle: ctx.isIdle(),
						prompt: event.messageType === "user" ? event.prompt : undefined,
					});
				});
			},
		});
		await f.session.prompt("user task");
		await f.session.sendCustomMessage(
			{ customType: "fixture", content: "custom task", display: true },
			{ triggerTurn: true },
		);
		expect(starts).toEqual([
			{ kind: "user", idle: false, prompt: "user task" },
			{ kind: "custom", idle: false, prompt: undefined },
		]);
		expect(f.requests).toHaveLength(2);
		expect(f.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(f.session.messages.some((message) => message.role === "custom")).toBe(true);
		expect(f.session.isIdle).toBe(true);
	});

	it("cancels during asynchronous startup before any model request, then accepts another run", async () => {
		let entered!: () => void, release!: () => void;
		const starting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const f = await fixture({
			name: "block-start",
			factory: (pi) => {
				pi.on("before_agent_start", async () => {
					if (first) {
						first = false;
						entered();
						await gate;
					}
				});
			},
		});
		const settled: boolean[] = [];
		f.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.push(event.aborted);
		});
		const running = f.session.prompt("cancel this");
		await starting;
		expect(f.session.isIdle).toBe(false);
		const aborting = f.session.abort();
		release();
		await Promise.all([running, aborting]);
		expect(f.requests).toHaveLength(0);
		// The SDK still enters the transport with an already-aborted signal; no request is sent.
		expect(f.abortedSignals).toEqual([true]);
		expect(settled).toEqual([true]);
		await f.session.prompt("next task");
		expect(f.requests).toHaveLength(1);
		expect(settled).toEqual([true, false]);
		expect(f.session.isIdle).toBe(true);
	});

	it("delivers shutdown while the extension context is still valid", async () => {
		const shutdown: boolean[] = [];
		const f = await fixture({
			name: "observe-shutdown",
			factory: (pi) => {
				pi.on("session_shutdown", (_event, ctx) => {
					shutdown.push(ctx.isIdle());
				});
			},
		});
		await emitSessionShutdown(f.session);
		f.session.dispose();
		expect(shutdown).toEqual([true]);
	});
});

describe("SDK 1.5.1 real offline tools", () => {
	it.each([false, true])(
		"MCP read-only calls bypass confirmation; unannotated calls require it: allow=%s",
		async (allow) => {
			const confirm = vi.fn(async () => allow);
			const f = await fixture(({ agentDir, cwd }) => {
				return [
					makePermissionGateExtension(agentDir, { projectRoot: cwd, confirm }),
					{
						name: "mcp",
						builtin: true,
						factory: createMcpExtension({
							logPath: join(agentDir, "mcp.log"),
							loadConfig: () => ({
								autoEnableCodemode: false,
								errors: [],
								servers: [
									{
										name: "fixture",
										source: join(agentDir, "mcp.json"),
										scope: "global",
										config: {
											command: process.execPath,
											args: [resolve("../../scripts/fake-mcp-server.mjs")],
											exposure: "direct",
										},
									},
								],
							}),
						}),
					},
				];
			}, "builtin");
			try {
				await f.session.bindExtensions({ mode: "rpc" });
				// The first prompt waits for direct MCP servers; binding alone only starts them in background.
				await f.session.prompt("wait for fixture MCP tools");
				expect(f.session.getActiveToolNames()).toContain("mcp__fixture__echo");
				expect(await f.callTool("mcp__fixture__echo", { text: "safe MCP echo" })).toMatchObject({
					isError: false,
				});
				expect(confirm).not.toHaveBeenCalled();
				const result = await f.callTool("mcp__fixture__nuke", { target: "synthetic-only" });
				expect(confirm).toHaveBeenCalledOnce();
				expect(result).toMatchObject({ isError: !allow });
			} finally {
				await emitSessionShutdown(f.session);
			}
		},
	);

	it.each([false, true])(
		"Code Mode 独占模式通过生产扩展改变模型工具表，内部调用仍可用：only=%s",
		async (only) => {
			const f = await fixture(({ agentDir, cwd }) => {
				writeFileSync(join(agentDir, "codemode.json"), JSON.stringify({ only }));
				return [
					makePermissionGateExtension(agentDir, { projectRoot: cwd, confirm: async () => false }),
					...builtinExtensions({ agentDir }).filter(
						(extension) => typeof extension !== "function" && extension.name === "codemode",
					),
				];
			}, "builtin");
			f.session.setActiveToolsByName(["read", "write", "edit", "bash", "codemode"]);
			const result = await f.callTool("codemode", {
				code: 'await tools.write({path:"only.txt",content:"ok"}); text(await tools.read({path:"only.txt"}));',
			});
			expect(result).toMatchObject({ isError: false });
			expect(readFileSync(join(f.cwd, "only.txt"), "utf8")).toBe("ok");
			if (only) expect(f.declaredTools[0]).toEqual(["codemode"]);
			else expect(f.declaredTools[0]).toEqual(expect.arrayContaining(["read", "write", "codemode"]));
		},
	);

	it("codemode executes a pure script without approval and persists its store", async () => {
		const confirm = vi.fn(async () => true);
		const f = await fixture(
			({ agentDir, cwd }) => [
				makePermissionGateExtension(agentDir, { projectRoot: cwd, confirm }),
				{ name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
			],
			"builtin",
		);
		f.session.setActiveToolsByName(["codemode"]);
		const result = await f.callTool("codemode", { code: 'store("fixture", 14); text(2 + 2);' });
		expect(confirm).not.toHaveBeenCalled();
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("4");
		expect(
			f.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
		).toBe(true);
	});

	it("codemode 内工作区读写免确认，越界写入、高危命令和受保护文件仍需确认", async () => {
		const confirm = vi.fn(async (_title: string) => false);
		const f = await fixture(
			({ agentDir, cwd }) => [
				makePermissionGateExtension(agentDir, { projectRoot: cwd, confirm }),
				{ name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
			],
			"builtin",
		);
		f.session.setActiveToolsByName(["read", "write", "edit", "bash", "codemode"]);
		const result = await f.callTool("codemode", {
			code: 'await tools.write({path:"note.txt",content:"before"}); await tools.edit({path:"note.txt",oldText:"before",newText:"after"}); text(await tools.read({path:"note.txt"}));',
		});
		expect(result).toMatchObject({ isError: false });
		expect(readFileSync(join(f.cwd, "note.txt"), "utf8")).toBe("after");
		expect(confirm).not.toHaveBeenCalled();
		const outside = resolve(f.cwd, "../outside.txt");
		await f.callTool("codemode", {
			code: `await tools.write({path:${JSON.stringify(outside)},content:"blocked"});`,
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]?.[0]).toContain("write");
		expect(existsSync(outside)).toBe(false);
		await f.callTool("codemode", { code: 'await tools.bash({command:"sudo echo blocked"});' });
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(confirm.mock.calls[1]?.[0]).toContain("bash");
		await f.callTool("codemode", {
			code: 'await tools.write({path:"permissions.json",content:"blocked"});',
		});
		expect(confirm).toHaveBeenCalledTimes(3);
		expect(confirm.mock.calls[2]?.[0]).toContain("write");
		expect(existsSync(join(f.cwd, "permissions.json"))).toBe(false);
	});
});
