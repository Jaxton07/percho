import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { messagesToUIMessages, type SessionSubagentMessage } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { sanitizeSessionMessage } from "../src/lan/sanitize";
import { toBranchSessionMessages } from "../src/session/messages";

const entry = (id: string, parentId: string | null, message: Record<string, unknown>) =>
	({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		message: { ...message, timestamp: 1 },
	}) as SessionEntry;
const round = (prefix: string, parentId: string | null): SessionEntry[] => [
	entry(`${prefix}-u`, parentId, {
		role: "user",
		content: [{ type: "text", text: "Same text and timestamp" }],
	}),
	entry(`${prefix}-a`, `${prefix}-u`, {
		role: "assistant",
		content: [
			{ type: "text", text: "Before tool" },
			{ type: "toolCall", id: "reused-call", name: "show_image", arguments: { paths: ["/synthetic.png"] } },
			{ type: "text", text: "After tool" },
		],
	}),
	entry(`${prefix}-t`, `${prefix}-a`, {
		role: "toolResult",
		toolCallId: "reused-call",
		toolName: "show_image",
		content: [{ type: "text", text: "Shown" }],
		details: { images: [{ data: "AQID", mimeType: "image/png" }] },
	}),
];

describe("页位置无关的真实entry/片段身份", () => {
	it("同timestamp/同文本/复用toolCallId仍绑定真实entry，完整与尾页具有相同身份", () => {
		const first = round("first", null),
			second = round("second", "first-t"),
			branch = [...first, ...second];
		const full = messagesToUIMessages(toBranchSessionMessages(branch, "owner")),
			tail = messagesToUIMessages(toBranchSessionMessages(second, "owner"));
		expect(full.filter((message) => message.id.startsWith("entry:owner:second-"))).toEqual(tail);
		expect(new Set(full.map((message) => message.id)).size).toBe(full.length);
		expect(messagesToUIMessages(toBranchSessionMessages(second, "fork-owner"))[0]?.id).not.toBe(tail[0]?.id);
		const tools = full.flatMap((message) => (message.kind === "assistant" ? message.tools : []));
		expect(new Set(tools.map((tool) => tool.key)).size).toBe(tools.length);
		expect(full.filter((message) => message.kind === "assistant").map((message) => message.entryId)).toEqual([
			"first-a",
			"first-a",
			"second-a",
			"second-a",
		]);
	});
	it("compaction、错误卡与子代理卡身份也不依赖页内index或随机key", () => {
		const compact = {
			type: "compaction",
			id: "compact",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			summary: "Summary",
			tokensBefore: 100,
		} as SessionEntry;
		const errors = [
			entry("error-u", "compact", { role: "user", content: [{ type: "text", text: "Question" }] }),
			entry("error-a", "error-u", {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Failure",
				content: [],
			}),
		];
		const full = messagesToUIMessages(toBranchSessionMessages([compact, ...errors])),
			tail = messagesToUIMessages(toBranchSessionMessages(errors));
		expect(full[0]?.id).toBe("entry:compact:0");
		expect(full.slice(1)).toEqual(tail);
		const runs: SessionSubagentMessage = {
			role: "subagent",
			historyId: "entry:child:0",
			entryId: "child",
			timestamp: 1,
			runs: [{ agent: "scout", status: "done" }],
		};
		expect(messagesToUIMessages([runs])).toEqual(messagesToUIMessages([runs]));
	});
	it("无来源的旧消费者仍使用旧fallback，LAN不泄漏entry或派生历史身份", () => {
		const messages = toBranchSessionMessages(round("private", null), "owner"),
			safe = messages.map(sanitizeSessionMessage);
		expect(JSON.stringify(safe)).not.toContain("entry:owner:private");
		expect(safe.every((message) => !message.entryId && !message.historyId)).toBe(true);
		expect(messagesToUIMessages(safe)[0]?.id).toBe("h0");
	});
});
