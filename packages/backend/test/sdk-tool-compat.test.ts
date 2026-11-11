import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createAssistantMessageEventStream,
	type Model,
	type Tool,
	type ToolCall,
	ToolCallArgumentsStream,
	validateToolCall,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createGrepTool,
	createReadTool,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id: "call",
	name,
	arguments: args,
});
describe("SDK 工具参数兼容", () => {
	it("真实会话执行 read 时转换字符串数值，并分页读取隔离大文件", async () => {
		const base = resolve("../../.local/tmp/sdk-tool-compat");
		mkdirSync(base, { recursive: true });
		const cwd = mkdtempSync(join(base, "run-"));
		writeFileSync(join(cwd, "large.txt"), Array.from({ length: 5000 }, (_, i) => `line-${i + 1}`).join("\n"));
		const model: Model<"anthropic-messages"> = {
			id: "test",
			name: "test",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 100,
		};
		const settingsManager = SettingsManager.inMemory({
			cacheWarming: "off",
			retry: { enabled: false },
			compaction: { enabled: false },
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
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			settingsManager,
			resourceLoader,
			tools: ["read"],
			sessionManager: SessionManager.inMemory(cwd),
			modelRuntime: {
				getModel: () => model,
				hasConfiguredAuth: () => true,
				checkAuth: async () => ({ type: "api_key", key: "test" }),
			} as unknown as ModelRuntime,
		});
		let calls = 0;
		session.agent.streamFunction = async () => {
			const result = createAssistantMessageEventStream();
			const toolUse = calls++ === 0;
			const message = {
				role: "assistant" as const,
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				stopReason: toolUse ? ("toolUse" as const) : ("stop" as const),
				content: toolUse
					? [call("read", { path: "large.txt", offset: "3000", limit: "2" })]
					: [{ type: "text" as const, text: "done" }],
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			result.push({ type: "done", reason: message.stopReason, message });
			return result;
		};
		try {
			await session.prompt("read the page");
			const result = session.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({ role: "toolResult", isError: false });
			expect(JSON.stringify(result)).toContain("line-3000");
			expect(JSON.stringify(result)).toContain("line-3001");
			expect(JSON.stringify(result)).not.toContain("line-3002");
		} finally {
			session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("grep 工厂执行相对 glob 并返回上下文", async () => {
		const base = resolve("../../.local/tmp/sdk-tool-compat");
		mkdirSync(base, { recursive: true });
		const cwd = mkdtempSync(join(base, "grep-"));
		try {
			mkdirSync(join(cwd, "nested"));
			writeFileSync(join(cwd, "nested", "yes.ts"), "before\nneedle\nafter\n");
			writeFileSync(join(cwd, "nested", "no.txt"), "needle\n");
			const result = await createGrepTool(cwd).execute("grep-1", {
				pattern: "needle",
				path: ".",
				glob: "**/*.ts",
				context: 1,
			});
			const output = JSON.stringify(result.content);
			expect(output).toContain("yes.ts");
			expect(output).toContain("before");
			expect(output).toContain("after");
			expect(output).not.toContain("no.txt");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("内置 read 必填路径，数值转换和非法类型由公开校验入口处理", () => {
		const tool = createReadTool(".");
		expect(validateToolCall([tool], call("read", { path: "file", offset: "2", limit: "3" }))).toMatchObject({
			path: "file",
			offset: 2,
			limit: 3,
		});
		expect(() => validateToolCall([tool], call("read", {}))).toThrow();
		expect(() => validateToolCall([tool], call("read", { path: "file", offset: "bad" }))).toThrow();
	});
	it("TypeBox 扩展 schema 和普通 MCP 风格 JSON schema 校验必填、枚举、数组及范围", () => {
		const extension: Tool = {
			name: "extension",
			description: "test",
			parameters: Type.Object({
				mode: Type.Union([Type.Literal("fast"), Type.Literal("safe")]),
				count: Type.Integer({ minimum: 1, maximum: 3 }),
				tags: Type.Array(Type.String(), { minItems: 1 }),
			}),
		};
		const mcp: Tool = {
			name: "mcp",
			description: "test",
			parameters: {
				type: "object",
				properties: {
					mode: { type: "string", enum: ["fast", "safe"] },
					count: { type: "integer", minimum: 1, maximum: 3 },
					tags: { type: "array", items: { type: "string" }, minItems: 1 },
				},
				required: ["mode", "count", "tags"],
			},
		};
		for (const tool of [extension, mcp]) {
			expect(validateToolCall([tool], call(tool.name, { mode: "fast", count: "2", tags: "one" }))).toEqual({
				mode: "fast",
				count: 2,
				tags: ["one"],
			});
			for (const args of [
				{ count: 1, tags: ["x"] },
				{ mode: "other", count: 1, tags: ["x"] },
				{ mode: "safe", count: 4, tags: ["x"] },
				{ mode: "safe", count: 1, tags: [] },
			]) {
				expect(() => validateToolCall([tool], call(tool.name, args))).toThrow();
			}
		}
	});
	it("大参数分片解析完成后保持原值，损坏的 JSON 不伪装成成功", () => {
		const value = { text: "large text ".repeat(20000), items: [1, 2, 3] };
		const json = JSON.stringify(value);
		const parser = new ToolCallArgumentsStream();
		for (let i = 0; i < json.length; i += 1024) parser.append(json.slice(i, i + 1024));
		expect(parser.finish()).toEqual({ arguments: value });
		const broken = new ToolCallArgumentsStream();
		broken.append('{"text":');
		expect(broken.finish().argumentsError).toBeTruthy();
	});
});
