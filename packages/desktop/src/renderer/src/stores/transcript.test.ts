import type { AgentSessionEvent } from "@percho/shared";
import { emptyTranscript, messagesToUIMessages, reduceEvent } from "@percho/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useTranscriptStore } from "./transcript";

function ev(type: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return { type, ...extra } as AgentSessionEvent;
}

const canonicalSkill = (args?: string) =>
	`<skill name="mindmap" location="/tmp/skills/mindmap/SKILL.md">\nReferences are relative to /tmp/skills/mindmap.\n\n# Mind map\n\nBody\n</skill>${args ? `\n\n${args}` : ""}`;

describe("transcript reducer", () => {
	it("subagent 互斥事件生成系统消息（结构化 + 同扩展去重）", () => {
		let state = reduceEvent(emptyTranscript(), {
			type: "subagent_mutex",
			extensionPath: "/tmp/pi-subagents.ts",
			tools: ["subagent", "subagent_wait"],
		});
		expect(state.messages[0]).toMatchObject({ kind: "system" });
		expect((state.messages[0] as { mutex?: { extensionPath: string; tools: string[] } }).mutex).toEqual({
			extensionPath: "/tmp/pi-subagents.ts",
			tools: ["subagent", "subagent_wait"],
		});
		// 同一扩展再次打开会话重发事件时不累积重复通知
		state = reduceEvent(state, {
			type: "subagent_mutex",
			extensionPath: "/tmp/pi-subagents.ts",
			tools: ["subagent", "subagent_wait"],
		});
		expect(state.messages).toHaveLength(1);
		// 不同扩展各自一条
		state = reduceEvent(state, {
			type: "subagent_mutex",
			extensionPath: "/tmp/other-subagents.ts",
			tools: ["subagent"],
		});
		expect(state.messages).toHaveLength(2);
	});

	it("用户消息经 message_start 进入消息流", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "你好" }] },
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ kind: "user", text: "你好" });
	});

	it("canonical skill 用户消息紧凑投影，并保留 sourceText 供撤回定位", () => {
		let state = reduceEvent(emptyTranscript(), {
			type: "message_start",
			message: { role: "user", content: canonicalSkill("topic\nmore"), timestamp: 1720000000000 },
		} as unknown as AgentSessionEvent);
		expect(state.messages[0]).toMatchObject({
			kind: "user",
			text: "topic\nmore",
			skill: { name: "mindmap", args: "topic\nmore" },
			sourceText: canonicalSkill("topic\nmore"),
			timestamp: 1720000000000,
		});

		state = reduceEvent(emptyTranscript(), {
			type: "message_start",
			message: { role: "user", content: canonicalSkill() },
		} as unknown as AgentSessionEvent);
		expect(state.messages[0]).toMatchObject({
			kind: "user",
			text: "",
			skill: { name: "mindmap", args: undefined },
			sourceText: canonicalSkill(),
		});
	});

	it("用户消息透传 SDK timestamp（撤回兑底定位用），缺省回退本地时间", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "message_start",
			message: { role: "user", content: "带时间戳", timestamp: 1720000000000 },
		} as unknown as AgentSessionEvent);
		expect(state.messages[0]).toMatchObject({ kind: "user", timestamp: 1720000000000 });

		state = emptyTranscript();
		const before = Date.now();
		state = reduceEvent(state, {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "无时间戳" }] },
		} as unknown as AgentSessionEvent);
		const ts = (state.messages[0] as { timestamp: number }).timestamp;
		expect(ts).toBeGreaterThanOrEqual(before);
	});

	it("message_start 提取图片块为 images", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "message_start",
			message: {
				role: "user",
				content: [
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "看图" },
				],
			},
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "user",
			text: "看图",
			images: [{ data: "AAAA", mimeType: "image/png" }],
		});
	});

	it("agent_start 进入流式，text_delta 累积", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		expect(state.phase).toBe("streaming");
		expect(state.agentActive).toBe(true);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.text).toBe("Hello world");
	});

	it("thinking 活动按 contentIndex 累积并保持首次到达位置", () => {
		let state = reduceEvent(emptyTranscript(), ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想" },
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.activity).toEqual([{ id: "h0", kind: "thinking", text: "先想" }]);
	});

	it("交错 thinking 与 tool 活动各自保留内容和到达顺序", () => {
		let state = reduceEvent(emptyTranscript(), ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "第一段" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { content: [{}, { type: "toolCall", name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"ls"}' },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "第二段" },
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.activity).toEqual([
			{ id: "h0", kind: "thinking", text: "第一段" },
			{ id: "c1", kind: "tool", name: "bash", args: '{"command":"ls"}' },
			{ id: "h2", kind: "thinking", text: "第二段" },
		]);
	});

	it("turn_end 固化为 assistant 消息并回到 idle", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
		} as unknown as AgentSessionEvent);
		// 固化消息复用流式容器预生成的 id（流式 → 固化不 remount，Markdown 平滑输出续播）
		const streamingId = state.streaming?.id;
		expect(streamingId).toBeTruthy();
		state = reduceEvent(state, ev("turn_end"));
		expect(state.phase).toBe("idle");
		expect(state.streaming).toBeNull();
		// turn_end 不结束 run：agentActive 保持（后续可能还有 turn）
		expect(state.agentActive).toBe(true);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ kind: "assistant", text: "Hi", id: streamingId });

		// run 结束（agent_end 无 willRetry）→ agentActive false
		state = reduceEvent(state, ev("agent_end", { willRetry: false, messages: [] }));
		expect(state.agentActive).toBe(false);
		// agent_settled 也置 false
		state = reduceEvent(state, ev("agent_start"));
		expect(state.agentActive).toBe(true);
		state = reduceEvent(state, ev("agent_settled"));
		expect(state.agentActive).toBe(false);
	});

	it("多轮工具循环：turn_start 重置容器，各轮内容分别固化为消息", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));

		// 第一轮：思考 + 2 个 bash
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "看一下" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { toolCalls: [{ name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { id: "tc1", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "bash",
			result: { output: "src" },
			isError: false,
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, ev("turn_end"));
		expect(state.streaming).toBeNull();
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "assistant",
			thinking: "看一下",
		});

		// 第二轮：新 turn_start 后继续累积，不得丢弃
		state = reduceEvent(state, ev("turn_start"));
		expect(state.phase).toBe("streaming");
		expect(state.streaming?.text).toBe("");
		expect(state.streaming?.tools).toHaveLength(0);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "再看" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "答案是 src" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, ev("turn_end"));
		state = reduceEvent(state, ev("agent_end", { willRetry: false, messages: [] }));

		expect(state.messages).toHaveLength(2);
		expect(state.messages[1]).toMatchObject({
			kind: "assistant",
			thinking: "再看",
			text: "答案是 src",
		});
	});

	it("toolcall 事件累积为工具卡片，tool_execution_* 流式输出", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools).toHaveLength(1);
		expect(state.streaming?.tools[0]).toMatchObject({ id: "tc1", name: "bash" });

		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "bash",
			args: { command: "ls" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_update",
			toolCallId: "tc1",
			toolName: "bash",
			args: {},
			partialResult: { output: "a.txt\nb.txt" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "bash",
			result: {},
			isError: false,
		} as unknown as AgentSessionEvent);
		const tool = state.streaming?.tools[0];
		expect(tool?.state).toBe("done");
		expect(tool?.output).toContain("a.txt");

		state = reduceEvent(state, ev("turn_end"));
		expect(state.messages[0]).toMatchObject({ kind: "assistant" });
	});

	it("并行两个 toolcall：contentIndex 交错时按块匹配，两个都能 done", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		// ci=0 与 ci=1 各自 start
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { content: [{ type: "toolCall", name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: {
					content: [
						{ type: "toolCall", name: "bash" },
						{ type: "toolCall", name: "grep" },
					],
				},
			},
		} as unknown as AgentSessionEvent);
		// delta 交错到来（SDK 保证事件可按任意块交错）
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 1,
				delta: '{"pattern":"ui"',
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"command":"ls"',
			},
		} as unknown as AgentSessionEvent);
		// end 交错：先 ci=1 再 ci=0
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { id: "call_b", name: "grep", arguments: { pattern: "ui" } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "call_a", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools).toHaveLength(2);
		expect(state.streaming?.tools[0]).toMatchObject({ id: "call_a", name: "bash" });
		expect(state.streaming?.tools[1]).toMatchObject({ id: "call_b", name: "grep" });
		// 执行事件各自匹配
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "call_b",
			toolName: "grep",
			result: {},
			isError: false,
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "call_a",
			toolName: "bash",
			result: {},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools.every((t) => t.state === "done")).toBe(true);
	});

	it("同 turn 正文后的工具拆分为独立 meta 消息（保住 text→toolCall 交错时序）", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		// turn 块序：[thinking, tool(pre), text, tool(post)] —— 模型“任务完成，清空列表”+todo clear 的典型交错
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想一下" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { content: [{}, { type: "toolCall", name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { id: "tc1", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "任务完成，清空列表" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 3,
				partial: { content: [{}, {}, {}, { type: "toolCall", name: "todo" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: { id: "tc2", name: "todo", arguments: { todos: [] } },
			},
		} as unknown as AgentSessionEvent);
		// 流式期就记录正文起点锚：后续工具按 blockIndex 判定在正文之后
		expect(state.streaming?.textBlockIndex).toBe(2);
		const streamingId = state.streaming?.id;
		state = reduceEvent(state, ev("turn_end"));
		// 固化拆两条：msg1 = thinking + 正文前工具 + 正文（保留流式 id）；msg2 = 正文后工具（无正文）
		expect(state.messages).toHaveLength(2);
		expect(state.messages[0]).toMatchObject({
			kind: "assistant",
			text: "任务完成，清空列表",
			thinking: "想一下",
			tools: [{ id: "tc1" }],
			id: streamingId,
		});
		expect(state.messages[1]).toMatchObject({
			kind: "assistant",
			text: "",
			thinking: "",
			tools: [{ id: "tc2" }],
		});
	});

	it("正文在工具前的 turn 不拆分（现状路径不变）", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { content: [{ type: "toolCall", name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "结果如下" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, ev("turn_end"));
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "assistant",
			text: "结果如下",
			tools: [{ id: "tc1" }],
		});
	});

	it("agent_end willRetry 保持流式，无重试回到 idle", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "agent_end",
			messages: [],
			willRetry: true,
		} as unknown as AgentSessionEvent);
		expect(state.phase).toBe("streaming");
		state = reduceEvent(state, {
			type: "agent_end",
			messages: [],
			willRetry: false,
		} as unknown as AgentSessionEvent);
		expect(state.phase).toBe("idle");
	});

	it("compaction_start 追加进行中系统消息，compaction_end 更新为摘要", () => {
		let state = emptyTranscript();
		expect(state.compacting).toBe(false);
		state = reduceEvent(state, {
			type: "compaction_start",
			reason: "manual",
		} as unknown as AgentSessionEvent);
		expect(state.compacting).toBe(true);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "system",
			compact: { status: "running", reason: "manual" },
		});
		const pendingId = state.messages[0]?.id;

		state = reduceEvent(state, {
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
			result: {
				summary: "讨论了图片上传实现",
				firstKeptEntryId: "x",
				tokensBefore: 12000,
				estimatedTokensAfter: 6000,
			},
		} as unknown as AgentSessionEvent);
		expect(state.compacting).toBe(false);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "system",
			id: pendingId,
			compact: {
				status: "done",
				summary: "讨论了图片上传实现",
				tokensBefore: 12000,
				tokensAfter: 6000,
			},
		});
	});

	it("compaction_end 后历史消息完整保留（问题一搭车修复：不再整体重置）", () => {
		// 预置：一轮完整对话（user + assistant 正文）已固化在消息流里
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "message_start",
			message: { role: "user", content: "早前的用户消息", timestamp: 1 },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, { type: "agent_start" } as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "早前的助手回复" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, { type: "turn_end" } as unknown as AgentSessionEvent);
		const before = state.messages.filter((m) => m.kind !== "system");
		expect(before.length).toBeGreaterThanOrEqual(2);

		// 压缩分界线到达：只追加 system 消息，历史消息原样保留（不再 loadHistory 重建）
		state = reduceEvent(state, {
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			result: { summary: "压缩摘要", firstKeptEntryId: "x", tokensBefore: 9000, estimatedTokensAfter: 3000 },
		} as unknown as AgentSessionEvent);
		const after = state.messages.filter((m) => m.kind !== "system");
		expect(after).toHaveLength(before.length);
		expect(after[0]).toBe(before[0]);
		expect(state.messages.some((m) => m.kind === "system")).toBe(true);
	});

	it("compaction_end 无进行中消息时追加；aborted 显示取消状态", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "compaction_end",
			reason: "threshold",
			aborted: true,
			willRetry: false,
		} as unknown as AgentSessionEvent);
		expect(state.compacting).toBe(false);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "system",
			compact: { status: "cancelled", reason: "threshold" },
		});
	});

	it("compaction_end 失败：剥掉 SDK errorMessage 自带的 Compaction failed 前缀", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction failed: Nothing to compact (session too small)",
		} as unknown as AgentSessionEvent);
		expect(state.compacting).toBe(false);
		expect(state.messages[0]).toMatchObject({
			kind: "system",
			compact: {
				status: "error",
				reason: "manual",
				errorMessage: "Nothing to compact (session too small)",
			},
		});
	});

	it("queue_update 整组替换 followUpQueue（排队/投递/清空同一通道）", () => {
		let state = emptyTranscript();
		expect(state.followUpQueue).toEqual([]);
		state = reduceEvent(state, ev("queue_update", { steering: [], followUp: ["第一条"] }));
		expect(state.followUpQueue).toEqual(["第一条"]);
		state = reduceEvent(state, ev("queue_update", { steering: [], followUp: ["第二条", "第三条"] }));
		expect(state.followUpQueue).toEqual(["第二条", "第三条"]);
		// 投递完成 SDK 推空数组
		state = reduceEvent(state, ev("queue_update", { steering: [], followUp: [] }));
		expect(state.followUpQueue).toEqual([]);
	});

	it("show_image：tool_execution_end 缓冲图片，turn_end 排在 assistant 之后", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "show_image" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "show_image", arguments: { paths: ["a.png", "b.png"] } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "show_image",
			result: {
				content: [{ type: "text", text: "2 images displayed to the user in the chat: a.png, b.png" }],
				details: {
					paths: ["a.png", "b.png"],
					images: [
						{ data: "AAAA", mimeType: "image/png" },
						{ data: "BBBB", mimeType: "image/png" },
					],
				},
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		// 图片先进缓冲（不落 messages），工具卡仍 done
		expect(state.messages).toHaveLength(0);
		expect(state.streaming?.pendingImages).toHaveLength(1);
		expect(state.streaming?.tools[0]?.state).toBe("done");

		// turn_end 固化：assistant 在前、图片在后（与历史回放顺序一致）
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "这是两张图" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, ev("turn_end"));
		expect(state.messages.map((m) => m.kind)).toEqual(["assistant", "image"]);
		expect(state.messages[1]).toMatchObject({
			kind: "image",
			images: [
				{ data: "AAAA", mimeType: "image/png" },
				{ data: "BBBB", mimeType: "image/png" },
			],
			paths: ["a.png", "b.png"],
		});
	});

	it("show_image 无正文内容时 turn_end 仍落缓冲图片（防御分支）", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		// 直接构造：streaming 无任何 text/thinking/tools 但带缓冲图片
		state = {
			...state,
			streaming: state.streaming && {
				...state.streaming,
				pendingImages: [{ images: [{ data: "AAAA", mimeType: "image/png" }], paths: ["a.png"] }],
			},
		};
		state = reduceEvent(state, ev("turn_end"));
		expect(state.messages.map((m) => m.kind)).toEqual(["image"]);
	});

	it("show_image 出错或其他工具带 details：不产出图片消息", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "show_image", arguments: { path: "missing.png" } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "show_image",
			result: { content: [{ type: "text", text: "file not found" }] },
			isError: true,
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(0);

		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc2",
			toolName: "webfetch",
			result: {
				content: [{ type: "text", text: "page" }],
				details: { url: "https://x", image: { data: "AAAA", mimeType: "image/png" } },
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(0);
	});

	it("subagent：tool_execution_start 建独立工作中行并从工具区移出", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "subagent" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "subagent", arguments: { agent: "reviewer", task: "review diff" } },
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools).toHaveLength(1);
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "subagent",
			args: { agent: "reviewer", task: "review diff" },
		} as unknown as AgentSessionEvent);
		// 从折叠工具区移出，进入独立 running 行
		expect(state.streaming?.tools).toHaveLength(0);
		expect(state.streaming?.subagentRuns).toHaveLength(1);
		expect(state.streaming?.subagentRuns[0]).toMatchObject({
			agent: "reviewer",
			task: "review diff",
			status: "running",
		});
	});

	it("subagent：progress 在运行中回填 sessionFile，保住 running 状态", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc-progress",
			toolName: "subagent",
			args: { agent: "reviewer", task: "review diff" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_update",
			toolCallId: "tc-progress",
			toolName: "subagent",
			partialResult: {
				details: {
					mode: "single",
					results: [
						{
							agent: "reviewer",
							task: "review diff",
							exitCode: -1,
							artifactPaths: { jsonlPath: "/tmp/subagent-running.jsonl" },
						},
					],
				},
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns[0]).toMatchObject({
			status: "running",
			sessionFile: "/tmp/subagent-running.jsonl",
		});
	});

	it("subagent：tool_execution_start 移出折叠区时同步摘除 ticker 活动条目（不进 Working 预览行）", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		// toolcall_start 建立 tools 条目 + activity 预览条目（id = c${contentIndex}）
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 2,
				partial: { toolCalls: [{ name: "subagent" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { id: "tc-sub", name: "subagent", arguments: { agent: "scout", task: "侦察" } },
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.activity.some((a) => a.id === "c2")).toBe(true);
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc-sub",
			toolName: "subagent",
			args: { agent: "scout", task: "侦察" },
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools).toHaveLength(0);
		expect(state.streaming?.activity.some((a) => a.id === "c2")).toBe(false);
		expect(state.streaming?.subagentRuns).toHaveLength(1);
		// end 兑底分支（无 start 占位但 details 命中）：同样摘除
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 3,
				partial: { toolCalls: [{ name: "subagent" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: { id: "tc-sub2", name: "subagent", arguments: { action: "list" } },
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.activity.some((a) => a.id === "c3")).toBe(true);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc-sub2",
			toolName: "subagent",
			result: {
				content: [{ type: "text", text: "done" }],
				details: { mode: "single", results: [{ agent: "scout", exitCode: 0 }] },
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.activity.some((a) => a.id === "c3")).toBe(false);
	});

	it("subagent：parallel tasks 建多个占位并整体替换，不残留占位", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "parallel-1",
			toolName: "subagent",
			args: {
				tasks: [
					{ agent: "scout", task: "read one" },
					{ agent: "scout", task: "read two" },
				],
			},
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(2);
		expect(state.streaming?.subagentRuns.map((run) => run.status)).toEqual(["running", "running"]);
		expect(state.streaming?.subagentRuns.map((run) => run.key)).toEqual(["parallel-1:0", "parallel-1:1"]);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "parallel-1",
			toolName: "subagent",
			result: {
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "parallel",
					results: [
						{ agent: "scout", task: "read one", exitCode: 0, sessionFile: "/one.jsonl" },
						{ agent: "scout", task: "read two", exitCode: 0, sessionFile: "/two.jsonl" },
					],
				},
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(2);
		expect(state.streaming?.subagentRuns.every((run) => run.status === "done")).toBe(true);
		expect(state.streaming?.subagentRuns.map((run) => run.sessionFile)).toEqual(["/one.jsonl", "/two.jsonl"]);
	});

	it("subagent：tool_execution_end 用 details 完善运行组，turn_end 固化为独立消息", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "subagent",
			args: { agent: "reviewer" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "subagent",
			result: {
				content: [{ type: "text", text: "reviewed" }],
				details: {
					artifacts: { dir: "/tmp/runs/abc" },
					results: [
						{
							index: 0,
							agent: "reviewer",
							task: "review diff",
							exitCode: 0,
							model: "anthropic/claude",
							usage: { totalTokens: { tokens: 12345 } },
							sessionFile: "/Users/x/.pi/agent/sessions/x/sub-agent-1.jsonl",
						},
					],
				},
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(1);
		expect(state.streaming?.subagentRuns[0]).toMatchObject({
			agent: "reviewer",
			task: "review diff",
			status: "done",
			model: "anthropic/claude",
			tokens: 12345,
			exitCode: 0,
			artifactsDir: "/tmp/runs/abc",
			sessionFile: "/Users/x/.pi/agent/sessions/x/sub-agent-1.jsonl",
		});
		// 无正文也固化（subagent 独立消息在 assistant 前补位）
		state = reduceEvent(state, ev("turn_end"));
		expect(state.messages.map((m) => m.kind)).toEqual(["subagent"]);
		expect(state.messages[0]).toMatchObject({
			kind: "subagent",
			runs: [{ agent: "reviewer", status: "done" }],
		});
	});

	it("subagent：一次调用多个子代理（fanout）替换占位组；错误标记", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "subagent",
			args: { agent: "reviewer" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "subagent",
			result: {
				content: [{ type: "text", text: "done" }],
				details: {
					results: [
						{ agent: "r1", exitCode: 0, sessionFile: "/s1.jsonl" },
						{ agent: "r2", exitCode: 1, error: "boom", sessionFile: "/s2.jsonl" },
					],
				},
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(2);
		expect(state.streaming?.subagentRuns[1]).toMatchObject({ agent: "r2", status: "error" });
	});

	it("subagent：非 subagent 工具但 details 带 results/sessionFile（结构检测兜底）", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc9",
			toolName: "custom_delegate",
			result: {
				content: [{ type: "text", text: "done" }],
				details: {
					results: [{ agent: "scout", sessionFile: "/s.jsonl" }],
				},
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(1);
		expect(state.streaming?.subagentRuns[0]).toMatchObject({ agent: "scout", status: "done" });
	});

	it("subagent：management（action）调用不建独立行，留在工具折叠区", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "subagent" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "subagent", arguments: { action: "list" } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "subagent",
			args: { action: "list" },
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(0);
		expect(state.streaming?.tools).toHaveLength(1);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "subagent",
			result: { content: [{ type: "text", text: "6 agents" }], details: { mode: "management", results: [] } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(0);
		expect(state.streaming?.tools[0]?.state).toBe("done");
	});

	it("subagent：wait 工具 details.completions 提取子代理行（后台并行）", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc4",
			toolName: "subagent_wait",
			result: {
				content: [{ type: "text", text: "all done" }],
				details: {
					mode: "management",
					results: [],
					completions: [
						{
							runId: "r1",
							agent: "workflow",
							success: true,
							results: [
								{ agent: "scout", success: true },
								{
									agent: "worker",
									success: true,
									artifactPaths: { outputPath: "/Users/x/.pi/agent/sessions/x/sub.jsonl" },
								},
								{
									agent: "worker",
									success: false,
									artifactPaths: { outputPath: "/Users/x/.pi/agent/sessions/x/sub2.jsonl" },
								},
							],
						},
					],
				},
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(3);
		expect(state.streaming?.subagentRuns[1]).toMatchObject({
			agent: "worker",
			status: "done",
			sessionFile: "/Users/x/.pi/agent/sessions/x/sub.jsonl",
		});
		expect(state.streaming?.subagentRuns[2]).toMatchObject({ agent: "worker", status: "error" });
	});

	it("subagent：普通工具带无关 details 不进子代理行", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc3",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: { url: "https://x" } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.subagentRuns).toHaveLength(0);
	});

	it("todo：tool_execution_end 设置/替换/清空列表，turn_end 后保留", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "todo",
			result: {
				content: [{ type: "text", text: "Current task list:\n1. [in_progress] a" }],
				details: {
					todos: [
						{ content: "a", status: "in_progress" },
						{ content: "b", status: "pending" },
					],
				},
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.todos).toEqual([
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "pending" },
		]);
		// turn_end 固化消息不清理 todos（跨 turn 存活）
		state = reduceEvent(state, ev("turn_end"));
		expect(state.todos).toHaveLength(2);

		// 再次调用整体替换
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc2",
			toolName: "todo",
			result: { details: { todos: [{ content: "c", status: "completed" }] } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.todos).toEqual([{ content: "c", status: "completed" }]);

		// 空数组 = 清空
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc3",
			toolName: "todo",
			result: { details: { todos: [] } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.todos).toEqual([]);
	});

	it("todo：error 结果忽略；非 todo 工具带 todos details 不误触发", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "todo",
			result: { details: { todos: [{ content: "a", status: "pending" }] } },
			isError: true,
		} as unknown as AgentSessionEvent);
		expect(state.todos).toEqual([]);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc2",
			toolName: "webfetch",
			result: { details: { todos: [{ content: "a", status: "pending" }] } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.todos).toEqual([]);
	});

	it("todo：无流式容器时也能提取（容错分支）", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "todo",
			result: { details: { todos: [{ content: "a", status: "in_progress" }] } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.todos).toEqual([{ content: "a", status: "in_progress" }]);
	});

	it("edit：tool_execution_end 把 details.patch 存进 UIToolCall.diff（turn-diff 数据源）", () => {
		const PATCH = `--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new\n`;
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "edit" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "edit", arguments: { path: "src/a.ts", edits: [] } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { diff: "...", patch: PATCH, firstChangedLine: 1 },
			},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools[0]?.diff).toBe(PATCH);

		// turn_end 固化后 diff 随消息存活
		state = reduceEvent(state, ev("turn_end"));
		const assistant = state.messages[0];
		if (assistant?.kind !== "assistant") throw new Error("expected assistant");
		expect(assistant.tools[0]?.diff).toBe(PATCH);
	});

	it("edit：error / details 缺 patch 时不写 diff 字段", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "edit" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "edit", arguments: { path: "a", edits: [] } },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "edit",
			result: { content: [{ type: "text", text: "no match" }], details: { patch: "--- a\n+++ b\n" } },
			isError: true,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools[0]?.diff).toBeUndefined();
	});

	it("轮次计时：tool_execution_end 盖 endedAt，agent_end/settled 盖 runEndedAt，agent_start 清", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		expect(state.runEndedAt).toBeUndefined();
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: { toolCalls: [{ name: "bash" }] },
			},
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "bash", arguments: { command: "ls" } },
			},
		} as unknown as AgentSessionEvent);
		const before = Date.now();
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "bash",
			result: {},
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.tools[0]?.endedAt).toBeGreaterThanOrEqual(before);
		state = reduceEvent(state, ev("turn_end"));
		// 固化后 endedAt 随消息存活（计时派生数据源）
		const assistant = state.messages[0];
		if (assistant?.kind !== "assistant") throw new Error("expected assistant");
		expect(assistant.tools[0]?.endedAt).toBeGreaterThanOrEqual(before);
		// willRetry=true 是重试中，run 未终结不盖戳
		state = reduceEvent(state, ev("agent_end", { willRetry: true, messages: [] }));
		expect(state.runEndedAt).toBeUndefined();
		const endBefore = Date.now();
		state = reduceEvent(state, ev("agent_end", { willRetry: false, messages: [] }));
		expect(state.runEndedAt).toBeGreaterThanOrEqual(endBefore);
		// 新 run 开工清旧戳
		state = reduceEvent(state, ev("agent_start"));
		expect(state.runEndedAt).toBeUndefined();
		// agent_settled 竞底路径也盖戳
		state = reduceEvent(state, ev("agent_settled"));
		expect(state.runEndedAt).toBeGreaterThanOrEqual(endBefore);
	});
});

describe("messagesToUIMessages 历史回放", () => {
	it("user 消息透传 entryId（撤回精确定位用）", () => {
		const ui = messagesToUIMessages([
			{ role: "user", text: "撤我", thinking: "", tools: [], images: [], timestamp: 1, entryId: "e1" },
			{ role: "assistant", text: "好", thinking: "", tools: [], images: [], timestamp: 2 },
		]);
		expect(ui[0]).toMatchObject({ kind: "user", entryId: "e1" });
		expect(ui[1]).not.toHaveProperty("entryId", "e1");
	});

	it("skill 历史消息保留紧凑元数据与 sourceText", () => {
		const sourceText = canonicalSkill("layout");
		const ui = messagesToUIMessages([
			{
				role: "user",
				text: "layout",
				thinking: "",
				tools: [],
				images: [],
				timestamp: 1,
				skill: { name: "mindmap", args: "layout" },
				sourceText,
			},
			{
				role: "user",
				text: "",
				thinking: "",
				tools: [],
				images: [],
				timestamp: 2,
				skill: { name: "mindmap", args: undefined },
				sourceText: canonicalSkill(),
			},
		]);
		expect(ui[0]).toMatchObject({
			kind: "user",
			text: "layout",
			skill: { name: "mindmap", args: "layout" },
			sourceText,
		});
		expect(ui[1]).toMatchObject({ kind: "user", text: "", skill: { name: "mindmap", args: undefined } });
	});

	it("历史 mapper 原样展示 user、assistant 与工具输出（不剥任何 tag）", () => {
		const raw = '<acp tokens="55" type="bash">m00058</acp>';
		const ui = messagesToUIMessages([
			{
				role: "user",
				text: `问题\n${raw}`,
				thinking: "",
				tools: [],
				images: [],
				timestamp: 1,
			},
			{
				role: "assistant",
				text: raw,
				thinking: "",
				tools: [{ id: "tool", name: "bash", args: "{}", output: `结果\n${raw}`, isError: false }],
				images: [],
				timestamp: 2,
			},
		]);
		expect(ui[0]).toMatchObject({ kind: "user", text: `问题\n${raw}` });
		expect((ui[0] as { sourceText?: string }).sourceText).toBeUndefined();
		expect(ui[1]).toMatchObject({
			kind: "assistant",
			text: raw,
			tools: [{ output: `结果\n${raw}` }],
		});
	});

	it("image 角色消息还原为图片消息，位置保持", () => {
		const ui = messagesToUIMessages([
			{ role: "user", text: "看图", thinking: "", tools: [], images: [], timestamp: 1 },
			{
				role: "assistant",
				text: "这是 logo",
				thinking: "",
				tools: [{ id: "tc1", name: "show_image", args: '{"path":"logo.png"}', output: "", isError: false }],
				images: [],
				timestamp: 2,
			},
			{ role: "image", images: [{ data: "AAAA", mimeType: "image/png" }], paths: ["logo.png"], timestamp: 3 },
		]);
		expect(ui.map((m) => m.kind)).toEqual(["user", "assistant", "image"]);
		expect(ui[2]).toMatchObject({
			kind: "image",
			images: [{ data: "AAAA", mimeType: "image/png" }],
			paths: ["logo.png"],
		});
	});

	it("subagent 角色消息还原为子代理消息", () => {
		const ui = messagesToUIMessages([
			{
				role: "subagent",
				runs: [{ agent: "reviewer", status: "done", sessionFile: "/s.jsonl" }],
				timestamp: 1,
			},
		]);
		expect(ui.map((m) => m.kind)).toEqual(["subagent"]);
		expect(ui[0]).toMatchObject({
			kind: "subagent",
			runs: [{ agent: "reviewer", status: "done", sessionFile: "/s.jsonl" }],
		});
	});

	it("SessionToolCall.diff 透传到 UIToolCall（历史 diff 侧栏）", () => {
		const ui = messagesToUIMessages([
			{ role: "user", text: "u", thinking: "", tools: [], images: [], timestamp: 1 },
			{
				role: "assistant",
				text: "",
				thinking: "",
				tools: [
					{
						id: "tc1",
						name: "edit",
						args: '{"path":"a.ts"}',
						output: "",
						isError: false,
						diff: "--- a\n+++ b\n",
					},
					{ id: "tc2", name: "read", args: "{}", output: "", isError: false },
				],
				images: [],
				timestamp: 2,
			},
		]);
		const assistant = ui[1];
		if (assistant?.kind !== "assistant") throw new Error("expected assistant");
		expect(assistant.tools[0]?.diff).toBe("--- a\n+++ b\n");
		expect(assistant.tools[1]?.diff).toBeUndefined();
	});
});

describe("transcript store unseenCompletion", () => {
	beforeEach(() => {
		useTranscriptStore.setState({ bySession: {} });
	});

	function entry(sessionId: string) {
		return useTranscriptStore.getState().bySession[sessionId];
	}

	it("后台会话 agent 结束 → 置完成未读；查看后清除", () => {
		const store = useTranscriptStore.getState();
		store.applyEvent("s1", ev("agent_start"), { isActiveViewing: false });
		expect(entry("s1")?.unseenCompletion).toBe(false);
		store.applyEvent("s1", ev("agent_end"), { isActiveViewing: false });
		expect(entry("s1")?.agentActive).toBe(false);
		expect(entry("s1")?.unseenCompletion).toBe(true);
		useTranscriptStore.getState().markCompletionSeen("s1");
		expect(entry("s1")?.unseenCompletion).toBe(false);
	});

	it("正被查看的会话结束 → 不置未读", () => {
		const store = useTranscriptStore.getState();
		store.applyEvent("s1", ev("agent_start"), { isActiveViewing: true });
		store.applyEvent("s1", ev("agent_end"), { isActiveViewing: true });
		expect(entry("s1")?.unseenCompletion).toBe(false);
	});

	it("重新开工清除未读；willRetry 不算完成", () => {
		const store = useTranscriptStore.getState();
		store.applyEvent("s1", ev("agent_start"), { isActiveViewing: false });
		store.applyEvent("s1", ev("agent_end", { willRetry: true }), { isActiveViewing: false });
		expect(entry("s1")?.agentActive).toBe(true);
		expect(entry("s1")?.unseenCompletion).toBe(false);
		store.applyEvent("s1", ev("agent_end"), { isActiveViewing: false });
		expect(entry("s1")?.unseenCompletion).toBe(true);
		// 新一轮开工清除
		store.applyEvent("s1", ev("agent_start"), { isActiveViewing: false });
		expect(entry("s1")?.unseenCompletion).toBe(false);
	});

	it("markAgentActive 乐观开工清未读；失败回滚不误置", () => {
		const store = useTranscriptStore.getState();
		store.applyEvent("s1", ev("agent_start"), { isActiveViewing: false });
		store.applyEvent("s1", ev("agent_end"), { isActiveViewing: false });
		expect(entry("s1")?.unseenCompletion).toBe(true);
		useTranscriptStore.getState().markAgentActive("s1", true);
		expect(entry("s1")?.unseenCompletion).toBe(false);
		// 发送失败回滚 false：不算完成，未读保持 false
		useTranscriptStore.getState().markAgentActive("s1", false);
		expect(entry("s1")?.unseenCompletion).toBe(false);
	});

	it("todo：loadHistory 不清列表（compaction 后消息重建不丢面板数据），loadTodos 覆盖", () => {
		const store = useTranscriptStore.getState();
		store.applyEvent("s1", {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "todo",
			result: { details: { todos: [{ content: "a", status: "in_progress" }] } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(entry("s1")?.todos).toEqual([{ content: "a", status: "in_progress" }]);
		store.loadHistory("s1", []);
		expect(entry("s1")?.todos).toEqual([{ content: "a", status: "in_progress" }]);
		store.loadTodos("s1", []);
		expect(entry("s1")?.todos).toEqual([]);
	});
});
