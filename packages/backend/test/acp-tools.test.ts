import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CompressionState,
	type Config,
	type CoreMessage,
	createCore,
	createInitialState,
	defaultConfig,
} from "acp-kernel";
import { describe, expect, it } from "vitest";
import type { AcpStore } from "../src/tools/acp-context/extension";
import { compressParams, makeAcpTools, prepareCompressArguments } from "../src/tools/acp-context/tools";

/** withAcpState 的直通实现（不经锁/落盘，单测聚焦工具行为） */
function makeHarness(initialState?: CompressionState, coreMessages: CoreMessage[] = []) {
	const core = createCore();
	const config: Config = defaultConfig(256000);
	// 生产流程复刻：context 钩子先跑 processTurn 分配 refs，模型才可能调 compress
	let state =
		initialState ??
		(coreMessages.length > 0
			? core.processTurn({ messages: coreMessages, state: createInitialState(), config, tokenCount: 1000 })
					.state
			: createInitialState());
	const store: AcpStore = {
		load: async () => state,
		save: async (_f, s) => {
			state = s;
		},
		reset: async () => {
			state = createInitialState();
		},
	};
	const saved: CompressionState[] = [];
	const tools = makeAcpTools({
		core,
		getConfig: () => config,
		withAcpState: async (_ctx, fn) => {
			const result = await fn({ state, coreMessages, config });
			if (result.state) {
				state = result.state;
				saved.push(state);
			}
			return result.value;
		},
	});
	const byName = (name: string) => {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool not found: ${name}`);
		return tool;
	};
	return {
		core,
		tools,
		byName,
		get state() {
			return state;
		},
		saved,
		store,
	};
}

function bigMessages(): CoreMessage[] {
	const messages: CoreMessage[] = [{ id: "e1", role: "user", contentType: "text", text: "x".repeat(6000) }];
	messages.push({
		id: "e2",
		role: "tool",
		contentType: "tool-result",
		toolName: "read",
		toolCallId: "tc1",
		text: "y".repeat(6000),
	});
	messages.push({ id: "e3", role: "user", contentType: "text", text: "follow up" });
	return messages;
}

describe("schema 拍平（openai-completions 顶层 anyOf 400 坑）", () => {
	it("compress/decompress/search_context 顶层都是 type:object，无 anyOf/oneOf/allOf", () => {
		for (const schema of [compressParams]) {
			const json = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
			expect(json.type).toBe("object");
			expect(json.anyOf).toBeUndefined();
			expect(json.oneOf).toBeUndefined();
			expect(json.allOf).toBeUndefined();
		}
		const tools = makeAcpTools({
			core: createCore(),
			getConfig: () => defaultConfig(256000),
			withAcpState: async () => {
				throw new Error("not reached");
			},
		});
		for (const tool of tools) {
			const json = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
			expect(json.type, `${tool.name} 顶层 object`).toBe("object");
			expect(json.anyOf).toBeUndefined();
			expect(json.oneOf).toBeUndefined();
			expect(json.allOf).toBeUndefined();
		}
	});
});

describe("prepareCompressArguments 宽容解析", () => {
	it("content 字符串 JSON / 单对象 / startRef 拼写都归一为 content 数组", () => {
		const fromStringifiedContent = prepareCompressArguments({
			content: '[{"startRef": "m00001", "endRef": "m00002", "summary": "abc"}]',
		}) as { content: Array<Record<string, unknown>> };
		expect(fromStringifiedContent.content[0]?.startId).toBe("m00001");

		const fromSingle = prepareCompressArguments({
			startId: "m00001",
			endId: "m00002",
			summary: "abc",
		}) as { content: Array<Record<string, unknown>> };
		expect(fromSingle.content).toHaveLength(1);
		expect(fromSingle.content[0]?.startId).toBe("m00001");

		const normalized = prepareCompressArguments({
			content: [{ startId: "m00001", endId: "m00002", summary: "s".repeat(60) }],
		}) as { content: Array<Record<string, unknown>> };
		expect(normalized.content[0]?.startId).toBe("m00001");
	});

	it("解析不出 range 时原样放行（execute 内诊断）", () => {
		const passthrough = prepareCompressArguments({ nope: 1 });
		expect(passthrough).toEqual({ nope: 1 });
	});
});

describe("compress execute 三路径", () => {
	it("成功路径：建块 + 落盘 + 结果文本", async () => {
		const h = makeHarness(undefined, bigMessages());
		const compress = h.byName("compress");
		const result = await compress.execute(
			"call-1",
			{ content: [{ startId: "m00001", endId: "m00002", summary: "s".repeat(60), topic: "t" }] } as never,
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("[Compressed → 1 block(s)");
		expect(h.state.blocks).toHaveLength(1);
		expect(h.saved).toHaveLength(1);
	});

	it("ref 不存在：blocksCreated=0 + 诊断文案（面向模型的行动指引）", async () => {
		const h = makeHarness(undefined, bigMessages());
		const compress = h.byName("compress");
		const result = await compress.execute(
			"call-2",
			{ content: [{ startId: "m99999", endId: "m99999", summary: "s".repeat(60) }] } as never,
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("[Nothing compressed.]");
	});

	it("范围太小（< minCompressRange）：拒绝 + 诊断", async () => {
		const messages: CoreMessage[] = [
			{ id: "e1", role: "user", contentType: "text", text: "tiny" },
			{ id: "e2", role: "user", contentType: "text", text: "also tiny" },
		];
		const h = makeHarness(undefined, messages);
		const compress = h.byName("compress");
		const result = await compress.execute(
			"call-3",
			{ content: [{ startId: "m00001", endId: "m00002", summary: "s".repeat(60) }] } as never,
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("[Nothing compressed.]");
		expect(h.state.blocks).toHaveLength(0);
	});

	it("非法参数（解析不出 range）：throw 面向模型的错误", async () => {
		const h = makeHarness(undefined, bigMessages());
		const compress = h.byName("compress");
		await expect(
			compress.execute("call-4", { content: [] } as never, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/ARRAY of \{startId, endId, summary\}/);
	});
});

describe("只读三件套", () => {
	it("decompress：块不存在给行动指引；存在返回内容", async () => {
		const messages = bigMessages();
		const h = makeHarness(undefined, messages);
		await h
			.byName("compress")
			.execute(
				"c1",
				{ content: [{ startId: "m00001", endId: "m00002", summary: "s".repeat(60) }] } as never,
				undefined,
				undefined,
				{} as ExtensionContext,
			);
		const missing = await h
			.byName("decompress")
			.execute("c2", { blockId: "b99" } as never, undefined, undefined, {} as ExtensionContext);
		expect(missing.content[0] && missing.content[0].type === "text" && missing.content[0].text).toContain(
			"not found",
		);

		const found = await h
			.byName("decompress")
			.execute("c3", { blockId: "b1" } as never, undefined, undefined, {} as ExtensionContext);
		const text = found.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("restored");
	});

	it("search_context：无命中/有命中两态", async () => {
		const h = makeHarness(undefined, bigMessages());
		const none = await h
			.byName("search_context")
			.execute("c1", { query: "zzzznomatch" } as never, undefined, undefined, {} as ExtensionContext);
		expect(none.content[0] && none.content[0].type === "text" && none.content[0].text).toContain(
			"No compressed blocks match",
		);
	});

	it("acp_status：返回用量报告文本", async () => {
		const h = makeHarness(undefined, bigMessages());
		const result = await h
			.byName("acp_status")
			.execute("c1", {} as never, undefined, undefined, {} as ExtensionContext);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text.length).toBeGreaterThan(0);
	});
});
