import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../src/permissions/gate";
import { SessionTraces } from "../src/session/traces";
import { discoverAgents } from "../src/tools/subagent/agents";
import { runSubagent } from "../src/tools/subagent/runner";

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

import { ReadOnlySessionView } from "../src/session/read-only-view";
import { SessionSourceSnapshots } from "../src/session/source-snapshot";

describe("SDK 实报费用", () => {
	it("子代理真实执行累计实报 total，并与历史统计一致", async () => {
		const base = resolve("../../.local/tmp/sdk-cost-compat");
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "subagent-"));
		const cwd = join(root, "project"),
			agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
		);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const model: Model<"openai-completions"> = {
			id: "offline",
			name: "offline",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 100,
		};
		let call = 0;
		factory.prepare = (session) => {
			session.agent.streamFunction = async () => {
				const first = call++ === 0;
				const message = {
					role: "assistant" as const,
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					stopReason: first ? ("toolUse" as const) : ("stop" as const),
					content: first
						? [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "fixture.txt" } }]
						: [{ type: "text" as const, text: "done" }],
					usage: {
						input: 1,
						output: 2,
						cacheRead: 3,
						cacheWrite: 4,
						totalTokens: first ? 10 : 20,
						cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: first ? 0.2 : 0.3 },
					},
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: message.stopReason, message });
				return stream;
			};
		};
		writeFileSync(join(cwd, "fixture.txt"), "fixture");
		const gate = new PermissionGate(() => {}),
			traces = new SessionTraces();
		try {
			const agent = (await discoverAgents(cwd, { agentDir, projectTrusted: true }))[0];
			if (!agent) throw new Error("Missing built-in worker");
			const result = await runSubagent(
				{
					getModelRuntime: async () =>
						({
							getModel: () => model,
							hasConfiguredAuth: () => true,
							checkAuth: async () => ({ type: "api_key", key: "test" }),
							getAuth: async () => undefined,
						}) as unknown as ModelRuntime,
					getSubagentModel: async () => undefined,
					getSubagentThinkingLevel: async () => undefined,
					getPermissionMode: () => "fullAccess",
					gate,
					traces,
				},
				{ agent: { ...agent, tools: ["read"] }, task: "Read fixture", cwd, projectTrusted: true, model },
			);
			expect(result.status).toBe("done");
			expect(call).toBe(2);
			expect(result.usage).toEqual({
				input: 2,
				output: 4,
				cacheRead: 6,
				cacheWrite: 8,
				cost: 0.5,
				totalTokens: { tokens: 20 },
			});
			const path = result.artifactPaths.jsonlPath;
			if (!path) throw new Error("Missing subagent history");
			const manager = SessionManager.open(path);
			const snapshot = new SessionSourceSnapshots().capture(
				{},
				{
					sessionId: manager.getSessionId(),
					header: () => manager.getHeader(),
					branch: () => manager.getBranch(),
					entries: () => manager.getEntries(),
				},
			);
			const view = new ReadOnlySessionView(
				manager.getSessionId(),
				path,
				{},
				{ snapshot: () => snapshot, running: () => undefined, exportHtml: async () => "" },
			);
			expect(view.getSessionStats().cost).toBeCloseTo(0.5);
			view.dispose();
		} finally {
			factory.prepare = () => {};
			gate.dispose();
			traces.disposeAll();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("实时与只读历史均计入消息、预热和摘要实报总额，包含旧分支且不按分项重算", async () => {
		const rootDir = resolve("../../.local/tmp/sdk-cost-compat");
		mkdirSync(rootDir, { recursive: true });
		const cwd = mkdtempSync(join(rootDir, "run-"));
		const manager = SessionManager.inMemory(cwd);
		const settings = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager: settings,
			noExtensions: true,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: manager,
			settingsManager: settings,
			resourceLoader: loader,
			noTools: true,
		});
		const usage = (total: number) => ({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total },
		});
		try {
			const root = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: usage(0.2),
				stopReason: "stop",
				timestamp: 2,
			});
			manager.appendUsage("cache_warm", "test", "test", usage(0.3));
			manager.appendCompaction("summary", root, 10, undefined, false, usage(0.4));
			manager.branch(root);
			manager.appendUsage("cache_warm", "test", "test", usage(0.1));
			const snapshots = new SessionSourceSnapshots();
			const snapshot = snapshots.capture(
				{},
				{
					sessionId: manager.getSessionId(),
					header: () => manager.getHeader(),
					branch: () => manager.getBranch(),
					entries: () => manager.getEntries(),
				},
			);
			const view = new ReadOnlySessionView(
				manager.getSessionId(),
				"isolated.jsonl",
				{},
				{ snapshot: () => snapshot, running: () => undefined, exportHtml: async () => "" },
			);
			expect(session.getSessionStats().cost).toBeCloseTo(1);
			expect(view.getSessionStats().cost).toBeCloseTo(session.getSessionStats().cost);
			expect(view.getSessionStats().tokens).toEqual(session.getSessionStats().tokens);
			view.dispose();
		} finally {
			session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
