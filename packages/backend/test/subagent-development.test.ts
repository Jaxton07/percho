import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../src/permissions/gate";
import { SessionTraces } from "../src/session/traces";
import { discoverAgents, type SubagentDefinition } from "../src/tools/subagent/agents";
import { type RunSubagentDeps, runSubagent, type SubagentRunHandle } from "../src/tools/subagent/runner";
import { makeSubagentTool } from "../src/tools/subagent/tool";

const factory = vi.hoisted(() => ({ prepare: (_session: AgentSession) => {} }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
	const actual = await original<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		createAgentSession: async (...args: Parameters<typeof actual.createAgentSession>) => {
			const created = await actual.createAgentSession(...args);
			factory.prepare(created.session);
			return created;
		},
	};
});

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

type Step = { name: string; arguments: Record<string, unknown> } | "hold" | "error";
let root: string, cwd: string, agentDir: string, mode: PermissionMode;
let sessions: AgentSession[];
let scripts: Step[][];
let handles: Map<string, SubagentRunHandle>;
let traces: SessionTraces;
let deps: RunSubagentDeps;
let definition: SubagentDefinition;
let originalAgentDir: string | undefined;
let requests: string[];

function response(step?: Step, aborted = false): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: aborted
			? "aborted"
			: step === "error"
				? "error"
				: step && step !== "hold"
					? "toolUse"
					: "stop",
		...(step === "error" ? { errorMessage: "offline model failure" } : {}),
		content:
			step && typeof step === "object"
				? [{ type: "toolCall", id: `call-${crypto.randomUUID()}`, ...step }]
				: [{ type: "text", text: "verified" }],
		usage: {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

beforeEach(async () => {
	const parent = resolve("../../.local/tmp/subagent-dev-capability");
	mkdirSync(parent, { recursive: true });
	root = mkdtempSync(join(parent, "offline-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(cwd, "AGENTS.md"), "Project rule: keep changes simple.");
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
	);
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mode = "fullAccess";
	sessions = [];
	scripts = [];
	handles = new Map();
	requests = [];
	traces = new SessionTraces();
	deps = {
		getModelRuntime: async () =>
			({
				getModel: () => model,
				hasConfiguredAuth: () => true,
				checkAuth: async () => ({ type: "api_key", key: "offline" }),
				getAuth: async () => undefined,
			}) as unknown as ModelRuntime,
		getSubagentModel: async () => undefined,
		getSubagentThinkingLevel: async () => undefined,
		getPermissionMode: () => mode,
		gate: new PermissionGate(
			(request) => {
				requests.push(request.title);
				deps.gate.respond(request.id, "allow");
			},
			() => {},
		),
		traces,
		registerRun: (id, handle) => {
			handles.set(id, handle);
		},
		unregisterRun: (id) => {
			handles.delete(id);
		},
	};
	definition = (await discoverAgents(cwd, { agentDir, projectTrusted: true }))[0]!;
	factory.prepare = (session) => {
		sessions.push(session);
		const script = scripts.shift() ?? [];
		session.agent.streamFunction = async (_model, _context, options) => {
			const step = script.shift();
			if (step === "hold")
				await new Promise<void>((done) => {
					if (options?.signal?.aborted) done();
					else options?.signal?.addEventListener("abort", () => done(), { once: true });
				});
			const message = response(step, options?.signal?.aborted);
			const stream = createAssistantMessageEventStream();
			if (message.stopReason === "error" || message.stopReason === "aborted")
				stream.push({ type: "error", reason: message.stopReason, error: message });
			else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			return stream;
		};
	};
});

afterEach(async () => {
	for (const handle of handles.values()) await handle.abort();
	for (const session of sessions) session.dispose();
	deps.gate.dispose();
	traces.disposeAll();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(root, { recursive: true, force: true });
});

const run = (agent = definition, signal?: AbortSignal) =>
	runSubagent(deps, {
		agent,
		task: "Implement and verify.",
		cwd,
		projectTrusted: true,
		model,
		signal,
		batchIndex: 2,
	});

describe("真实离线子代理开发链路", () => {
	it("等审批时单独停止会撤销本代理请求，不取消另一代理的审批", async () => {
		mode = "default";
		deps.gate.dispose();
		deps.gate = new PermissionGate(() => {});
		scripts.push(
			[{ name: "bash", arguments: { command: "rm -rf harmless-a" } }],
			[{ name: "bash", arguments: { command: "rm -rf harmless-b" } }],
		);
		const first = run(),
			second = run();
		await vi.waitFor(() => expect(deps.gate.listPending()).toHaveLength(2));
		await handles.get(sessions[0]!.sessionId)!.abort();
		expect((await first).status).toBe("aborted");
		expect(deps.gate.listPending()).toHaveLength(1);
		await handles.get(sessions[1]!.sessionId)!.abort();
		await second;
		expect(deps.gate.listPending()).toEqual([]);
	});
	it("同文件 edit 冲突可识别，子代理重读后纠正；没有跨代理写锁", async () => {
		writeFileSync(join(cwd, "shared.txt"), "old");
		scripts.push(
			[{ name: "edit", arguments: { path: "shared.txt", oldText: "old", newText: "new" } }, "hold"],
			[
				{ name: "edit", arguments: { path: "shared.txt", oldText: "old", newText: "other" } },
				{ name: "read", arguments: { path: "shared.txt" } },
				{ name: "edit", arguments: { path: "shared.txt", oldText: "new", newText: "final" } },
			],
		);
		const first = run();
		await vi.waitFor(() => expect(readFileSync(join(cwd, "shared.txt"), "utf8")).toBe("new"));
		const second = await run();
		expect(second.status).toBe("done");
		expect(readFileSync(join(cwd, "shared.txt"), "utf8")).toBe("final");
		expect(JSON.stringify(sessions[1]?.messages)).toContain("Could not find");
		expect(sessions[0]?.isStreaming).toBe(true);
		await handles.get(sessions[0]!.sessionId)!.abort();
		await first;
	});

	it("首条消息之前失败丢弃不可打开路径，转发不影响 trace 记录", async () => {
		const prepare = factory.prepare;
		factory.prepare = (session) => {
			prepare(session);
			vi.spyOn(session, "prompt").mockRejectedValue(new Error("before messages"));
		};
		const result = await run();
		expect(result.status).toBe("failed");
		expect(result.artifactPaths).toEqual({});
		factory.prepare = prepare;
		const record = vi.spyOn(traces, "record");
		deps.onEvent = vi.fn();
		await run();
		expect(record.mock.calls.some(([, event]) => event.type === "agent_settled")).toBe(true);
		expect(deps.onEvent).toHaveBeenCalled();
	});
	it("worker 改文件、运行命令并派生事实，SDK 保留项目约定", async () => {
		scripts.push([
			{ name: "write", arguments: { path: "result.txt", content: "one\ntwo" } },
			{ name: "bash", arguments: { command: "exit 1" } },
		]);
		const result = await run();
		expect(result.status).toBe("done");
		expect(readFileSync(join(cwd, "result.txt"), "utf8")).toBe("one\ntwo");
		expect(result.summary).toMatchObject({
			changedFiles: [{ path: "result.txt", added: 2, removed: 0 }],
			commands: [{ command: "exit 1", isError: true }],
			failedCommands: 1,
		});
		expect(result.artifactPaths.jsonlPath).toBeTruthy();
		expect(sessions[0]?.systemPrompt).toContain("Project rule: keep changes simple.");
		expect(sessions[0]?.systemPrompt).toContain("read");
		expect(requests).toEqual([]);
		expect(handles.size).toBe(0);
	});

	it("默认不能提权；审批带批内序号；运行中模式切换即时生效", async () => {
		mode = "default";
		scripts.push([
			{ name: "bash", arguments: { command: "rm -rf harmless-a" } },
			{ name: "bash", arguments: { command: "rm -rf harmless-b" } },
		]);
		const confirm = vi.spyOn(deps.gate, "confirm");
		confirm.mockImplementation(async () => {
			mode = "fullAccess";
			return true;
		});
		expect((await run({ ...definition, permissionMode: "fullAccess" })).status).toBe("done");
		expect(confirm).toHaveBeenCalledOnce();
		expect(confirm.mock.calls[0]?.[0]).toContain("worker #2");
		expect(readFileSync(join(agentDir, "permission-audit.jsonl"), "utf8")).toContain("harmless-b");
	});

	it("fullAccess 下 deny 与 git 边界仍被拒，拒绝不是任务最终失败", async () => {
		scripts.push([
			{ name: "bash", arguments: { command: "git push" } },
			{ name: "write", arguments: { path: "denied.txt", content: "bad" } },
		]);
		const result = await run({ ...definition, deny: ["write"] });
		expect(result.status).toBe("done");
		const results = sessions[0]!.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.every((m) => m.isError)).toBe(true);
		expect(JSON.stringify(results)).toContain("代理边界");
	});

	it("单独中止只影响指定实例，父中止传到全部，trace 关闭", async () => {
		scripts.push(["hold"], ["hold"]);
		const controller = new AbortController();
		const stop = vi.spyOn(traces, "stop");
		const first = run(definition, controller.signal),
			second = run(definition, controller.signal);
		await vi.waitFor(() => expect(sessions).toHaveLength(2));
		await vi.waitFor(() => expect(sessions.every((s) => s.isStreaming)).toBe(true));
		await handles.get(sessions[0]!.sessionId)!.abort();
		expect((await first).status).toBe("aborted");
		expect(sessions[1]?.isStreaming).toBe(true);
		controller.abort();
		expect((await second).status).toBe("aborted");
		expect(stop).toHaveBeenCalledTimes(2);
		expect(handles.size).toBe(0);
	});

	it("模型错误为 failed，任务书不进入系统提示", async () => {
		scripts.push(["error"], []);
		expect((await run()).status).toBe("failed");
		await runSubagent(deps, { agent: definition, task: "Different task", cwd, model, projectTrusted: true });
		expect(sessions[0]?.systemPrompt).toBe(sessions[1]?.systemPrompt);
		expect(sessions[0]?.systemPrompt).not.toContain("Implement and verify.");
	});

	it("工具缺省使用 worker，cwd 无效；六任务先排队、逐项结束", async () => {
		scripts.push(["hold"], ["hold"], ["hold"], ["hold"], [], []);
		const tool = makeSubagentTool(deps);
		const updates: unknown[] = [];
		const task = tool.execute(
			"batch",
			{ tasks: Array.from({ length: 6 }, (_, i) => ({ task: `task ${i}`, cwd: "/invalid" })) },
			undefined,
			(update) => updates.push(structuredClone(update)),
			{ cwd, model, hasUI: false, isProjectTrusted: () => true } as ExtensionContext,
		);
		await vi.waitFor(() => expect(sessions).toHaveLength(4));
		await vi.waitFor(() => expect(sessions.every((s) => s.isStreaming)).toBe(true));
		const states = () =>
			(updates.at(-1) as { details: { results: Array<{ status: string }> } }).details.results.map(
				(r) => r.status,
			);
		expect(states()).toEqual(["running", "running", "running", "running", "queued", "queued"]);
		await handles.get(sessions[0]!.sessionId)!.abort();
		await vi.waitFor(() => expect(sessions).toHaveLength(6));
		await vi.waitFor(() =>
			expect(states()).toEqual(["aborted", "running", "running", "running", "done", "done"]),
		);
		for (const handle of handles.values()) await handle.abort();
		const result = await task;
		expect(result.isError).toBeUndefined();
		expect(sessions.every((s) => s.sessionManager.getCwd() === cwd)).toBe(true);
	});
});
