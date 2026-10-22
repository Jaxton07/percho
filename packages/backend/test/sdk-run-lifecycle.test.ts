import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
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
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePermissionGateExtension } from "../src/permissions/extension";
import { emitSessionShutdown } from "../src/session/shutdown";

const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const model: Model<"openai-completions"> = {
	id: "lifecycle-test",
	name: "lifecycle-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function fixture(
	extension: InlineExtension | ((paths: { agentDir: string; cwd: string }) => InlineExtension[]),
	noTools: "all" | "builtin" = "all",
) {
	const root = mkdtempSync(join(tmpdir(), "sdk-lifecycle-"));
	roots.push(root);
	const cwd = join(root, "project"),
		agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
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
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: typeof extension === "function" ? extension({ agentDir, cwd }) : [extension],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		resourceLoader,
		noTools,
		sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		modelRuntime: {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test-key" }),
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
	});
	sessions.push(session);
	const requests: unknown[] = [];
	const abortedSignals: boolean[] = [];
	let nextTool: { name: string; arguments: Record<string, unknown> } | undefined;
	session.agent.streamFunction = async (_model, context, options) => {
		const aborted = options?.signal?.aborted === true;
		abortedSignals.push(aborted);
		if (!aborted) requests.push(structuredClone(context.messages));
		const tool = nextTool;
		nextTool = undefined;
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			stopReason: aborted ? "aborted" : tool ? "toolUse" : "stop",
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
		if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
		else stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
		return stream;
	};
	return {
		session,
		requests,
		abortedSignals,
		callTool: async (name: string, args: Record<string, unknown>) => {
			nextTool = { name, arguments: args };
			await session.prompt(`fixture ${name}`);
			return session.messages.findLast((message) => message.role === "toolResult");
		},
	};
}

describe("SDK 1.4 real offline run lifecycle", () => {
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

describe("SDK 1.4 real offline tools", () => {
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

	it("codemode executes a pure script through the permission gate and persists its store", async () => {
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
		expect(confirm).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("4");
		expect(
			f.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
		).toBe(true);
	});
});
