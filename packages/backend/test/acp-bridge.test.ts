import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { describe, expect, it } from "vitest";
import type { ContentBlock, RawMessage } from "../src/session/messages";
import {
	alignOriginals,
	type BridgeEntry,
	coreOutToAgentMessages,
	entriesToCoreMessages,
} from "../src/tools/acp-context/bridge";

function userEntry(id: string, text: string, content?: ContentBlock[]): BridgeEntry {
	return { type: "message", id, message: { role: "user", content: content ?? text, timestamp: 1 } };
}

function assistantTextEntry(id: string, text: string): BridgeEntry {
	return {
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 },
	};
}

function toolCallEntry(id: string, calls: Array<{ id: string; name: string; args?: unknown }>): BridgeEntry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: calls.map((c) => ({
				type: "toolCall",
				id: c.id,
				name: c.name,
				arguments: (c.args ?? {}) as Record<string, unknown>,
			})),
			timestamp: 1,
		},
	};
}

function toolResultEntry(id: string, callId: string, text: string): BridgeEntry {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text }],
			timestamp: 1,
		},
	};
}

describe("entriesToCoreMessages", () => {
	it("user/assistant/toolResult 投影 + toolName/toolCallId 回填", () => {
		const entries = [
			userEntry("e1", "hello"),
			toolCallEntry("e2", [{ id: "tc1", name: "read" }]),
			toolResultEntry("e3", "tc1", "file content"),
			assistantTextEntry("e4", "done"),
		];
		const core = entriesToCoreMessages(entries);
		expect(core.map((m) => `${m.role}/${m.contentType}`)).toEqual([
			"user/text",
			"assistant/tool-call",
			"tool/tool-result",
			"assistant/text",
		]);
		expect(core[1]?.toolName).toBe("read");
		expect(core[2]?.toolCallId).toBe("tc1");
	});

	it("assistant 多工具调用拆 id#callId；单调用保留正文", () => {
		const single = entriesToCoreMessages([
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "看两个文件" },
						{ type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
					],
					timestamp: 1,
				},
			},
		]);
		expect(single).toHaveLength(1);
		expect(single[0]?.text).toContain("看两个文件");
		expect(single[0]?.text).toContain('"path"');

		const multi = entriesToCoreMessages([
			toolCallEntry("e2", [
				{ id: "a", name: "read", args: { path: "x" } },
				{ id: "b", name: "read", args: { path: "y" } },
			]),
		]);
		expect(multi.map((m) => m.id)).toEqual(["e2#a", "e2#b"]);
	});

	it("thinking-only assistant 不投影；custom/compaction 投影为 user 文本", () => {
		const entries: BridgeEntry[] = [
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: 1 },
			},
			{ type: "custom_message", id: "e2", customType: "todo-reminder", content: "reminder" },
			{ type: "compaction", id: "e3", summary: "compact summary" },
		];
		const core = entriesToCoreMessages(entries);
		expect(core.map((m) => `${m.id}:${m.role}`)).toEqual(["e2:user", "e3:user"]);
	});

	it("R1：fallback 路径 projectEntries 透传 custom_message 的 display/details", () => {
		const entries: BridgeEntry[] = [
			{
				type: "custom_message",
				id: "e1",
				customType: "todo-reminder",
				content: "reminder",
				display: false,
				details: { todos: [{ content: "t", status: "pending" }] },
			},
		];
		// 对齐失配（eventMessages 为空）→ originals 回退投影消息，display/details 必须还在
		const { originals, aligned } = alignOriginals(entries, []);
		expect(aligned).toBe(false);
		const fallback = originals.get("e1");
		expect(fallback?.display).toBe(false);
		expect((fallback?.details as { todos?: unknown[] })?.todos).toHaveLength(1);
	});

	it("R2：多工具调用拆分把正文挂第一条拆分消息（token 估算/可压范围覆盖正文）", () => {
		const entries = [
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "两条工具调用的正文说明" },
						{ type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
						{ type: "toolCall", id: "b", name: "read", arguments: { path: "y" } },
					],
					timestamp: 1,
				},
			},
		];
		const core = entriesToCoreMessages(entries);
		expect(core.map((m) => m.id)).toEqual(["e1#a", "e1#b"]);
		expect(core[0]?.text).toContain("两条工具调用的正文说明");
		expect(core[1]?.text).not.toContain("两条工具调用的正文说明");
	});
});

describe("alignOriginals", () => {
	it("index+role 对齐时 originals 取 event.messages（保上游变换）；失配回退 entries", () => {
		const entries = [userEntry("e1", "hi"), assistantTextEntry("e2", "yo")];
		const transformed: RawMessage[] = [
			{ role: "user", content: "hi（已被上游替换）", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "yo（已替换）" }], timestamp: 1 },
		];
		const aligned = alignOriginals(entries, transformed);
		expect(aligned.aligned).toBe(true);
		expect(aligned.originals.get("e1")?.content).toBe("hi（已被上游替换）");

		const misaligned = alignOriginals(entries, [{ role: "user", content: "只有一条", timestamp: 1 }]);
		expect(misaligned.aligned).toBe(false);
		expect(misaligned.originals.get("e1")?.content).toBe("hi");
	});
});

describe("coreOutToAgentMessages round-trip", () => {
	it("无压缩时原样返回（保 image block / thoughtSignature 完整结构）", () => {
		const imageBlock: ContentBlock = { type: "image", data: "base64...", mimeType: "image/png" };
		const entries = [
			userEntry("e1", "看图", [{ type: "text", text: "看图" }, imageBlock]),
			assistantTextEntry("e2", "好的"),
		];
		const core = entriesToCoreMessages(entries);
		const originals = new Map<string, RawMessage>();
		for (const e of entries) if (e.message) originals.set(e.id, e.message);
		const rebuilt = coreOutToAgentMessages(core, originals);
		expect(rebuilt).toHaveLength(2);
		const first = rebuilt[0]?.content as ContentBlock[];
		expect(first.some((b) => b.type === "image" && b.data === "base64...")).toBe(true);
	});

	it("processTurn 输出（带 <acp> 标签）回注：标签进最后 text block，正文不变", () => {
		// e0 = 首条 user（kernel 永不折叠）；压缩 e1..e2 段
		const entries = [
			userEntry("e0", "initial question"),
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }],
					timestamp: 1,
				},
			},
			toolResultEntry("e2", "tc1", "y".repeat(6000)),
			userEntry("e3", "next question"),
		];
		const core = entriesToCoreMessages(entries);
		const config = defaultConfig(256000, { protectedTools: ["todo"] });
		const core2 = createCore();
		// 生产流程复刻：applyCompression 前先 processTurn 分配 refs
		const warmed = core2.processTurn({
			messages: core,
			state: createInitialState(),
			config,
			tokenCount: 1000,
		});
		const applied = core2.applyCompression({
			ranges: [{ startRef: "m00002", endRef: "m00003", summary: "s".repeat(60), topic: "t" }],
			messages: core,
			state: warmed.state,
			config,
		});
		expect(applied.result.blocksCreated).toBe(1);
		const turn = core2.processTurn({
			messages: core,
			state: applied.state,
			config,
			tokenCount: 1000,
		});
		// 视图：e0 + 摘要 + e3（带标签）
		expect(turn.messages.some((m) => m.id.startsWith("acp_summary_"))).toBe(true);
		const originals = new Map<string, RawMessage>();
		for (const e of entries) if (e.message) originals.set(e.id, e.message);
		const rebuilt = coreOutToAgentMessages(turn.messages, originals);
		const roles = rebuilt.map((m) => m.role);
		expect(roles).toEqual(["user", "custom", "user"]);
		// 摘要消息形状
		const summary = rebuilt[1] as RawMessage & { customType?: string; details?: { blockId?: string } };
		expect(summary.customType).toBe("acp-summary");
		expect(summary.details?.blockId).toBe("b1");
		expect(String(summary.content)).toContain("[Compressed conversation section]");
		// 幸存消息注入了标签（模型可见 ref 坐标系）
		const last = rebuilt[2]?.content;
		expect(JSON.stringify(last)).toMatch(/<acp [^>]*>m\d+<\/acp>/);
	});

	it("孤儿 ref（originals 缺失）不炸：跳过该消息", () => {
		const core = entriesToCoreMessages([userEntry("e1", "hi")]);
		const rebuilt = coreOutToAgentMessages(core, new Map());
		expect(rebuilt).toHaveLength(0);
	});

	it("多工具调用部分压缩：回转合并只保留幸存 callId", () => {
		// 直接构造 kernel 视图输出（部分拆分 id 幸存）：测 bridge 的 baseId 合并逻辑，
		// 不依赖 applyCompression 的范围机制（pair 扩展会把整对拉进，真实场景由 hide/pull 产生）
		const entries = [
			userEntry("e1", "x".repeat(6000)),
			toolCallEntry("e2", [
				{ id: "a", name: "read", args: { path: "x" } },
				{ id: "b", name: "read", args: { path: "y" } },
			]),
			toolResultEntry("e3", "a", "content-a".repeat(1000)),
			toolResultEntry("e4", "b", "content-b".repeat(1000)),
			userEntry("e5", "end"),
		];
		const originals = new Map<string, RawMessage>();
		for (const e of entries) if (e.message) originals.set(e.id, e.message);
		// 视图：e2#a 与 e3（其结果）已被折叠掉，e2#b/e4/e5 幸存
		const coreOut = [
			{ id: "e1", role: "user" as const, contentType: "text" as const, text: "x".repeat(6000) },
			{
				id: "e2#b",
				role: "assistant" as const,
				contentType: "tool-call" as const,
				toolName: "read",
				toolCallId: "b",
				text: '<acp tokens="9" type="tool:read">m00003</acp>\n{"path":"y"}',
			},
			{
				id: "e4",
				role: "tool" as const,
				contentType: "tool-result" as const,
				toolName: "read",
				toolCallId: "b",
				text: "content-b".repeat(1000),
			},
			{ id: "e5", role: "user" as const, contentType: "text" as const, text: "end" },
		];
		const rebuilt = coreOutToAgentMessages(coreOut, originals);
		const merged = rebuilt.find((m) => {
			const c = m.content;
			return Array.isArray(c) && c.some((b) => b.type === "toolCall");
		});
		expect(merged).toBeTruthy();
		const calls = ((merged?.content ?? []) as ContentBlock[]).filter((b) => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect((calls[0] as { id?: string }).id).toBe("b");
	});
});
