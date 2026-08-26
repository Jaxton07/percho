import {
	buildChatRows,
	type ChatRow,
	emptyTranscript,
	isAgentWorking,
	type StreamingState,
	type UIMessage,
	type UIToolCall,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

/** buildChatRows 契约：与桌面 MessageList 原内联循环逐行为等价（重构时人工比对 + 本测试固化）。 */

function tool(name: string, state: UIToolCall["state"] = "done", blockIndex?: number): UIToolCall {
	return { key: `k-${name}-${blockIndex ?? 0}`, id: "", name, args: "", output: "", state, blockIndex };
}

function assistant(text: string, extra: Partial<Extract<UIMessage, { kind: "assistant" }>> = {}): UIMessage {
	return {
		kind: "assistant",
		id: `a-${text.slice(0, 6)}-${Math.random().toString(36).slice(2, 6)}`,
		text,
		thinking: "",
		tools: [],
		timestamp: 1,
		...extra,
	};
}

function streaming(overrides: Partial<StreamingState>): StreamingState {
	return {
		id: "stream-1",
		text: "",
		thinking: "",
		tools: [],
		pendingImages: [],
		subagentRuns: [],
		subagentByToolCallId: {},
		activeToolIndex: -1,
		toolByContentIndex: {},
		activity: [],
		textBlockIndex: null,
		...overrides,
	};
}

function kinds(rows: ChatRow[]): string[] {
	return rows.map((r) => r.kind);
}

describe("buildChatRows", () => {
	it("thinking/tools merge into a meta group; text is a boundary row", () => {
		const t = {
			...emptyTranscript(),
			messages: [assistant("正文", { thinking: "想", tools: [tool("read"), tool("edit")] })],
		};
		const rows = buildChatRows(t, "s1");
		expect(kinds(rows)).toEqual(["metaGroup", "message"]);
		expect(rows[0]).toMatchObject({ kind: "metaGroup", working: false, endImmediately: true });
		expect((rows[0] as { items: unknown[] }).items).toHaveLength(1);
		expect(rows[1]).toMatchObject({ kind: "message", metaInGroup: true, showActions: true });
	});

	it("text splits consecutive tool runs into two groups (order preserved)", () => {
		const t = {
			...emptyTranscript(),
			messages: [
				assistant("第一段", { tools: [tool("read")] }),
				assistant("第二段", { tools: [tool("bash")] }),
			],
		};
		const rows = buildChatRows(t, "s1");
		expect(kinds(rows)).toEqual(["metaGroup", "message", "metaGroup", "message"]);
		// 每轮只给末段正文挂操作行
		expect(rows[1]).toMatchObject({ showActions: false });
		expect(rows[3]).toMatchObject({ showActions: true });
	});

	it("user message closes turn; new turn gets its own actions row", () => {
		const t = {
			...emptyTranscript(),
			messages: [
				assistant("回复一"),
				{ kind: "user", id: "u1", text: "问", images: [], timestamp: 2 } as UIMessage,
				assistant("回复二"),
			],
		};
		const rows = buildChatRows(t, "s1");
		expect(rows[0]).toMatchObject({ kind: "message", showActions: true });
		expect(rows[2]).toMatchObject({ kind: "message", showActions: true });
	});

	it("subagent message: status row (subagentCount) flushed before the card row", () => {
		const t = {
			...emptyTranscript(),
			messages: [
				assistant("", { tools: [tool("subagent")] }),
				{ kind: "subagent", id: "sub1", runs: [{ key: "r1" }], timestamp: 2 } as unknown as UIMessage,
			],
		};
		const rows = buildChatRows(t, "s1");
		expect(kinds(rows)).toEqual(["metaGroup", "message"]);
		expect(rows[0]).toMatchObject({ kind: "metaGroup", subagentCount: 1 });
	});

	it("streaming: tools split pre/post by textBlockIndex; streaming text row synthesized with stable id", () => {
		const t = {
			...emptyTranscript(),
			agentActive: true,
			streaming: streaming({
				text: "正文流",
				textBlockIndex: 2,
				tools: [tool("read", "done", 0), tool("bash", "running", 3)],
				activity: [{ id: "ac1", kind: "tool", name: "bash", args: "" }],
			}),
		};
		const rows = buildChatRows(t, "s1");
		expect(kinds(rows)).toEqual(["metaGroup", "message", "metaGroup"]);
		// pre 组被正文强制结束，不携带活动序列
		expect(rows[0]).toMatchObject({ kind: "metaGroup", endImmediately: true, working: false });
		expect((rows[0] as { items: { activity?: unknown }[] }).items[0]?.activity).toBeUndefined();
		expect(rows[1]).toMatchObject({ kind: "message", streaming: true, key: "stream-1", metaInGroup: true });
		// post 组是最新组：接 working 信号 + 活动序列
		expect(rows[2]).toMatchObject({ kind: "metaGroup", working: true });
		expect((rows[2] as { items: { activity?: unknown[] }[] }).items[0]?.activity).toHaveLength(1);
	});

	it("working empty group placeholder when agent active without content", () => {
		const t = { ...emptyTranscript(), agentActive: true, streaming: streaming({}) };
		const rows = buildChatRows(t, "s1");
		expect(kinds(rows)).toEqual(["metaGroup"]);
		expect(rows[0]).toMatchObject({ working: true, endImmediately: false, items: [] });
	});

	it("streaming subagent runs: status row then card row last", () => {
		const run = {
			key: "r1",
			task: " scout ",
			status: "running" as const,
			details: [],
		};
		const t = {
			...emptyTranscript(),
			agentActive: true,
			streaming: streaming({ subagentRuns: [run as never] }),
		};
		const rows = buildChatRows(t, "s1");
		expect(kinds(rows)).toEqual(["metaGroup", "streamingSubagents"]);
		expect(rows[0]).toMatchObject({ subagentCount: 1, working: true });
		expect(rows[1]).toMatchObject({ key: "streaming-subagents" });
	});

	it("group keys are positional and session-scoped", () => {
		const t = {
			...emptyTranscript(),
			messages: [assistant("甲", { tools: [tool("read")] }), assistant("乙", { tools: [tool("read")] })],
		};
		const keys = buildChatRows(t, "s1")
			.filter((r) => r.kind === "metaGroup")
			.map((r) => r.key);
		expect(keys).toEqual(["meta-s1-g0", "meta-s1-g1"]);
	});
});

describe("isAgentWorking", () => {
	it("idle when not agentActive", () => {
		expect(isAgentWorking(emptyTranscript())).toBe(false);
	});
	it("working when active without text", () => {
		expect(isAgentWorking({ ...emptyTranscript(), agentActive: true, streaming: streaming({}) })).toBe(true);
	});
	it("stays lit when text out but tool still running; dark when all done", () => {
		const base = { ...emptyTranscript(), agentActive: true };
		expect(
			isAgentWorking({ ...base, streaming: streaming({ text: "x", tools: [tool("bash", "running", 1)] }) }),
		).toBe(true);
		expect(
			isAgentWorking({ ...base, streaming: streaming({ text: "x", tools: [tool("bash", "done", 1)] }) }),
		).toBe(false);
	});
});

describe("committed MetaItem 稳定性（WeakMap 缓存）", () => {
	it("同一消息对象重复构建 → metaGroup items 元素引用稳定（MetaGroup memo 依赖）", () => {
		const t = {
			...emptyTranscript(),
			messages: [
				assistant("正文一", { tools: [tool("read"), tool("bash")] }),
				assistant("正文二", { tools: [tool("edit")] }),
			],
		};
		const first = buildChatRows(t, "s1");
		// 模拟流式期间反复重建：streaming 变化不影响历史消息的 items 引用
		const second = buildChatRows({ ...t, streaming: streaming({ text: "x" }) }, "s1");
		const groupsA = first.filter((r) => r.kind === "metaGroup");
		const groupsB = second.filter((r) => r.kind === "metaGroup");
		expect(groupsA.length).toBeGreaterThan(0);
		for (const [i, ga] of groupsA.entries()) {
			const gb = groupsB[i];
			if (!gb) continue;
			expect(ga.items.length).toBe(gb.items.length);
			for (const [j, item] of ga.items.entries()) {
				expect(gb.items[j]).toBe(item); // 身份相等，不是深比较
			}
		}
	});

	it("消息对象被替换（loadHistory 重建）→ 缓存自然失效，取新值", () => {
		const msg1 = assistant("旧正文", { tools: [tool("read")] });
		const t1 = { ...emptyTranscript(), messages: [msg1] };
		const r1 = buildChatRows(t1, "s1").find((r) => r.kind === "metaGroup");
		const t2 = { ...emptyTranscript(), messages: [{ ...msg1, tools: [tool("edit")] }] };
		const r2 = buildChatRows(t2, "s1").find((r) => r.kind === "metaGroup");
		expect(r1?.items[0]?.tools[0]?.name).toBe("read");
		expect(r2?.items[0]?.tools[0]?.name).toBe("edit");
	});
});
