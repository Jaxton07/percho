import type { AgentSessionEvent } from "@pi-desktop/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useTranscriptStore } from "./transcript";
import { emptyTranscript, messagesToUIMessages, reduceEvent } from "./transcript-reducer";

function ev(type: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return { type, ...extra } as AgentSessionEvent;
}

describe("transcript reducer", () => {
	it("用户消息经 message_start 进入消息流", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "你好" }] },
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ kind: "user", text: "你好" });
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

	it("turn_end 固化为 assistant 消息并回到 idle", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, ev("agent_start"));
		state = reduceEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
		} as unknown as AgentSessionEvent);
		state = reduceEvent(state, ev("turn_end"));
		expect(state.phase).toBe("idle");
		expect(state.streaming).toBeNull();
		// turn_end 不结束 run：agentActive 保持（后续可能还有 turn）
		expect(state.agentActive).toBe(true);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({ kind: "assistant", text: "Hi" });

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
		state = reduceEvent(state, {
			type: "compaction_start",
			reason: "manual",
		} as unknown as AgentSessionEvent);
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

	it("compaction_end 无进行中消息时追加；aborted 显示取消状态", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, {
			type: "compaction_end",
			reason: "threshold",
			aborted: true,
			willRetry: false,
		} as unknown as AgentSessionEvent);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]).toMatchObject({
			kind: "system",
			compact: { status: "cancelled", reason: "threshold" },
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
});

describe("messagesToUIMessages 历史回放", () => {
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
});
