import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	executionContract,
	REMOTE_PROTOCOL_VERSION,
	type RuntimeRequest,
	type SessionBaseline,
} from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionHandlers } from "../src/execution-handlers";
import { PiBackend } from "../src/pi-backend";
import { RuntimeClient } from "../src/runtime/client";
import { RuntimeWriter, readRuntimeFrames } from "../src/runtime/frames";
import { SessionMediaStore } from "../src/session/media-store";
import { ReadOnlySessionView } from "../src/session/read-only-view";
import type { SessionRegistry } from "../src/session/registry";
import type { SubagentRunHandle } from "../src/tools/subagent/runner";

let directory: string, file: string;
const backends = new Set<PiBackend>();
const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "synthetic",
	api: "openai-completions",
	provider: "synthetic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 1024,
};
const usage = {
	input: 4,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 6,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const image = { mimeType: "image/png", data: Buffer.alloc(512 * 1024, 17).toString("base64") };
function assistant(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "done" }],
		usage,
		stopReason: "stop",
		timestamp: 4,
	};
}
function backend() {
	const modelRuntimeFactory = vi
		.spyOn(ModelRuntime, "create")
		.mockRejectedValue(new Error("Inspector must not create model runtime"));
	const instance = new PiBackend({
		projectTrust: false,
		permissionGates: false,
		sessionMediaStore: new SessionMediaStore(join(directory, "media")),
	});
	backends.add(instance);
	return { backend: instance, modelRuntimeFactory };
}
beforeEach(async () => {
	const root = resolve("../../.local/tmp/read-only-view");
	await mkdir(root, { recursive: true });
	directory = await mkdtemp(join(root, "run-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	const sessions = join(directory, "sessions-subagents", "project");
	await mkdir(sessions, { recursive: true });
	file = join(sessions, "child.jsonl");
	const rows = [
		{ type: "session", version: 3, id: "child", cwd: directory, timestamp: "2025-01-01T00:00:00Z" },
		{
			type: "message",
			id: "u",
			parentId: null,
			timestamp: "2025-01-01T00:00:01Z",
			message: { role: "user", content: "child image", timestamp: 1 },
		},
		{
			type: "message",
			id: "a",
			parentId: "u",
			timestamp: "2025-01-01T00:00:02Z",
			message: {
				...assistant(),
				content: [{ type: "toolCall", id: "call", name: "show_image", arguments: {} }],
				stopReason: "toolUse",
			},
		},
		{
			type: "message",
			id: "r",
			parentId: "a",
			timestamp: "2025-01-01T00:00:03Z",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "show_image",
				timestamp: 3,
				isError: false,
				content: [],
				details: { images: [image] },
			},
		},
	];
	await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
});
afterEach(async () => {
	for (const backend of backends) backend.dispose();
	backends.clear();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

describe("只读检视不是第二个SDK会话", () => {
	it("生产handler与分块协议传递引用基线和单图原字节，不接受路径式读取", async () => {
		const { backend: b } = backend(),
			handlers = createExecutionHandlers(b, { allowInteractiveAuth: false });
		const requests = new PassThrough(),
			responses = new PassThrough(),
			writer = new RuntimeWriter(responses);
		const reader = readRuntimeFrames(
			(value) => {
				const request = value as RuntimeRequest;
				void (async () => {
					if (request.type === "attach") {
						writer.write({
							type: "result",
							id: request.id,
							result: {
								info: {
									...executionContract(),
									protocol: REMOTE_PROTOCOL_VERSION,
									runtimeVersion: "synthetic",
									environmentId: "remote",
									instanceId: "loopback",
									canonicalAgentDir: directory,
									uid: 1,
									pid: 1,
									startedAt: 1,
								},
								epoch: 1,
							},
						});
						return;
					}
					if (request.type !== "invoke") return;
					try {
						writer.write({
							type: "result",
							id: request.id,
							result: await handlers[request.method](request.args),
						});
					} catch (error) {
						writer.write({
							type: "result",
							id: request.id,
							code: "READ_FAILED",
							error: error instanceof Error ? error.message : "Read failed",
						});
					}
				})();
			},
			(error) => {
				throw error;
			},
		);
		requests.on("data", reader);
		const client = RuntimeClient.fromStream(
			Duplex.from({ readable: responses, writable: requests }),
			() => {},
		);
		try {
			await client.attach("synthetic-desktop");
			await client.invoke("openSession", { filePath: file });
			const baseline = (await client.invoke("getSessionBaseline", {
				sessionId: "child",
				imageMode: "references",
			})) as SessionBaseline;
			const message = baseline.transcript.messages.find((row) => row.kind === "image");
			const reference = message?.kind === "image" ? message.images[0] : undefined;
			if (!reference || !("id" in reference)) throw new Error("No remote reference");
			expect(JSON.stringify(baseline)).not.toContain(image.data);
			expect(
				await client.invoke("getSessionImage", {
					sessionId: "child",
					imageId: reference.id,
					revision: reference.revision,
				}),
			).toMatchObject(image);
			await expect(
				client.invoke("getSessionImage", {
					sessionId: "child",
					imageId: "../source.png",
					revision: reference.revision,
				}),
			).rejects.toThrow();
			expect(b.getSessionSourceStats()).toMatchObject({ views: 1, parses: 1 });
		} finally {
			client.close();
			writer.dispose();
			requests.destroy();
			responses.destroy();
		}
	});
	it("结束源一次纯解析；重复open、baseline及多次取图不重读或启动模型/扩展", async () => {
		const { backend: b, modelRuntimeFactory } = backend(),
			before = await readFile(file);
		const sdkOpen = vi.spyOn(SessionManager, "open");
		const meta = await b.openSession(file);
		expect(meta).toMatchObject({ sessionId: "child", readOnly: true });
		const internal = b as unknown as { registry: SessionRegistry },
			entry = internal.registry.get("child");
		expect(entry?.session).toBeInstanceOf(ReadOnlySessionView);
		for (let index = 0; index < 4; index++) {
			await b.openSession(file);
			const baseline = b.getSessionBaseline("child", { imageMode: "references" });
			const message = baseline.transcript.messages.find((row) => row.kind === "image");
			if (message?.kind !== "image") throw new Error("Missing image");
			const ref = message.images[0];
			if (!ref || !("id" in ref)) throw new Error("Missing reference");
			expect((await b.getSessionImage("child", ref.id, ref.revision)).data).toBe(image.data);
		}
		expect(b.getSessionSourceStats()).toMatchObject({ parses: 1, views: 1 });
		expect(sdkOpen).not.toHaveBeenCalled();
		expect(modelRuntimeFactory).not.toHaveBeenCalled();
		await expect(b.prompt("child", "must not run")).rejects.toThrow(/read.only|只读/i);
		expect(await b.getStats("child")).toMatchObject({ inputTokens: 4, outputTokens: 2 });
		expect(await readFile(file)).toEqual(before);
		await b.closeSession("child");
		expect(b.getSessionSourceStats().views).toBe(0);
	});
	it("只读JSONL和公开SDK CLI HTML导出仍自包含，临时副本不进历史且不改原文件", async () => {
		const { backend: b, modelRuntimeFactory } = backend(),
			before = await readFile(file);
		await b.openSession(file);
		const jsonl = await b.exportSession("child", "jsonl"),
			html = await b.exportSession("child", "html");
		expect(jsonl).toContain(image.data);
		expect(html).toContain('id="session-data"');
		const encoded = html.match(/id="session-data"[^>]*>([^<]+)</)?.[1];
		if (!encoded) throw new Error("Missing SDK data");
		expect(Buffer.from(encoded, "base64").toString("utf8")).toContain(image.data);
		expect(await readFile(file)).toEqual(before);
		expect(await readdir(resolve(file, ".."))).toEqual(["child.jsonl"]);
		expect(modelRuntimeFactory).not.toHaveBeenCalled();
	}, 30000);
	it("正在运行时借用真正SDK；检视GC不停止它、不给它派发shutdown或关闭媒体所有者", async () => {
		const manager = SessionManager.open(file),
			settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: settings,
			noExtensions: true,
		});
		await loader.reload();
		const runtime = {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ status: "ok" }),
			getAuthApiKey: async () => "synthetic-test-only",
		} as unknown as ModelRuntime;
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			mode: "rpc",
			model,
			modelRuntime: runtime,
			settingsManager: settings,
			sessionManager: manager,
			resourceLoader: loader,
			noTools: true,
			tools: [],
		});
		const { backend: b, modelRuntimeFactory } = backend(),
			abort = vi.fn(() => session.abort()),
			dispose = vi.fn(() => session.dispose());
		const internal = b as unknown as {
			runningSubagents: Map<string, SubagentRunHandle>;
			registry: SessionRegistry;
			media: SessionMediaStore;
		};
		let completeRun!: () => void;
		const completion = new Promise<void>((resolve) => {
			completeRun = resolve;
		});
		internal.runningSubagents.set("child", {
			completion,
			getSource: () => session,
			getBranch: () => manager.getBranch(),
			abort,
			dispose,
		});
		const mediaOwner = {};
		internal.media.openOwner("child", mediaOwner);
		const liveLease = internal.media.lease("child", () => true);
		let finish!: () => void, started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		session.agent.streamFunction = async () => {
			started();
			return new Promise((resolve) => {
				finish = () => {
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message: assistant() });
					resolve(stream);
				};
			});
		};
		const off = session.subscribe((event) => b.emitSubagentEvent("child", event, () => session.abort()));
		const run = session.prompt("still running");
		try {
			await entered;
			const leaf = manager.getLeafId();
			await b.openSession(file);
			const baseline = b.getSessionBaseline("child", { imageMode: "references" });
			expect(baseline.transcript.agentActive).toBe(true);
			const entry = internal.registry.get("child");
			if (!(entry?.session instanceof ReadOnlySessionView)) throw new Error("Missing inspector");
			expect(entry.session.sessionManager).toBe(manager);
			expect(entry.session.snapshot.entries[0]).toBe(manager.getEntries()[0]);
			expect(b.getSessionSourceStats().parses).toBe(0);
			expect(await b.closeSession("child", "gc")).toEqual({ closed: true });
			expect(session.isStreaming).toBe(true);
			expect(manager.getLeafId()).toBe(leaf);
			expect(abort).not.toHaveBeenCalled();
			expect(dispose).not.toHaveBeenCalled();
			expect(() => liveLease.assert()).not.toThrow();
			expect(b.getSessionSourceStats().views).toBe(0);
			expect(modelRuntimeFactory).not.toHaveBeenCalled();
			await expect(b.deleteSession("wrong-owner", file)).rejects.toThrow(/owner/);
			expect(abort).not.toHaveBeenCalled();
			const deleting = b.deleteSession("child", file);
			void deleting.catch(() => {});
			await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
			finish();
			await run;
			// SDK停止不代表runner收尾完成，最后一次写入仍必须在删除之前。
			manager.appendCustomEntry("late-finalize", { safe: true });
			expect(await readFile(file, "utf8")).toContain("late-finalize");
			internal.runningSubagents.delete("child");
			completeRun();
			await deleting;
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			expect(() => liveLease.assert()).toThrow();
		} finally {
			completeRun();
			finish?.();
			await run;
			off();
			internal.runningSubagents.delete("child");
			session.dispose();
		}
	});
});
