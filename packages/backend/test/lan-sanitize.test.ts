import {
	LAN_IMAGE_PLACEHOLDER,
	REDUCED_EVENT_TYPES,
	type SessionEvent,
	type SessionMessage,
} from "@percho/shared";
import { describe, expect, it } from "vitest";
import { sanitizeSessionEvent, sanitizeSessionMessage } from "../src/lan/sanitize";

describe("sanitizeSessionMessage", () => {
	it("strips sourceText and replaces user images with placeholders (count preserved)", () => {
		const message = {
			role: "user",
			text: "hello",
			thinking: "",
			tools: [],
			images: [
				{ data: "aGVsbG8=", mimeType: "image/png" },
				{ data: "d29ybGQ=", mimeType: "image/jpeg" },
			],
			timestamp: 1,
			sourceText: "/skill:secret 全文",
			skill: { name: "mindmap", args: "x" },
		} satisfies SessionMessage;
		const out = sanitizeSessionMessage(message);
		expect(out.role).toBe("user");
		expect("sourceText" in out).toBe(false);
		expect(out.role === "user" && out.skill).toEqual({ name: "mindmap", args: "x" });
		expect(out.images).toHaveLength(2);
		expect(out.images.every((img) => img.data === LAN_IMAGE_PLACEHOLDER)).toBe(true);
	});

	it("strips assistant sourceText and images", () => {
		const message = {
			role: "assistant",
			text: "ok",
			sourceText: "raw secret source",
			thinking: "",
			tools: [],
			images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
			timestamp: 1,
		} satisfies SessionMessage;
		const out = sanitizeSessionMessage(message);
		expect("sourceText" in out).toBe(false);
		expect(out.images[0]?.data).toBe(LAN_IMAGE_PLACEHOLDER);
	});

	it("keeps image message as placeholder with paths stripped", () => {
		const message = {
			role: "image",
			images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
			paths: ["/Users/secret/shot.png"],
			timestamp: 1,
		} satisfies SessionMessage;
		const out = sanitizeSessionMessage(message);
		expect(out.role).toBe("image");
		expect(out.role === "image" && out.paths).toEqual([]);
		expect(out.images[0]?.mimeType).toBe("image/x-lan-stripped");
	});

	it("strips subagent sessionFile/artifactsDir but keeps result fields", () => {
		const message = {
			role: "subagent",
			runs: [
				{
					agent: "scout",
					task: "调研",
					status: "done",
					model: "deepseek",
					tokens: 123,
					exitCode: 0,
					sessionFile: "/Users/secret/.pi/agent/sessions-subagents/x.jsonl",
					artifactsDir: "/Users/secret/.pi/agent/sessions-subagents/x",
				},
			],
			timestamp: 1,
		} satisfies SessionMessage;
		const out = sanitizeSessionMessage(message);
		expect(out.role).toBe("subagent");
		const run = out.role === "subagent" ? out.runs[0] : undefined;
		expect(run).toMatchObject({ agent: "scout", task: "调研", tokens: 123 });
		expect(run && "sessionFile" in run).toBe(false);
		expect(run && "artifactsDir" in run).toBe(false);
	});
});

describe("sanitizeSessionEvent", () => {
	it("replaces image content blocks in message_start with placeholders", () => {
		const event = {
			type: "message_start",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "看图" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		} as unknown as SessionEvent;
		const out = sanitizeSessionEvent(event);
		expect(out?.type).toBe("message_start");
		const content = (out as { message: { content: Array<{ type: string; data?: string }> } }).message.content;
		expect(content[0]).toEqual({ type: "text", text: "看图" });
		expect(content[1]?.data).toBe(LAN_IMAGE_PLACEHOLDER);
	});

	it("sanitizes show_image tool results (details images/paths)", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "show_image",
			result: {
				content: [{ type: "text", text: "已显示" }],
				details: {
					paths: ["/Users/secret/a.png"],
					images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
				},
			},
			isError: false,
		} as unknown as SessionEvent;
		const out = sanitizeSessionEvent(event) as {
			result: { details: { paths: string[]; images: Array<{ data: string }> } };
		};
		expect(out.result.details.paths).toEqual([]);
		expect(out.result.details.images[0]?.data).toBe(LAN_IMAGE_PLACEHOLDER);
	});

	it("strips sessionFile/artifactsDir from subagent tool result details", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "subagent",
			result: {
				details: {
					results: [
						{ agent: "scout", status: "done", sessionFile: "/secret/x.jsonl", artifactsDir: "/secret/x" },
					],
				},
			},
			isError: false,
		} as unknown as SessionEvent;
		const out = sanitizeSessionEvent(event) as {
			result: { details: { results: Array<Record<string, unknown>> } };
		};
		const run = out.result.details.results[0];
		expect(run).toMatchObject({ agent: "scout", status: "done" });
		expect(run && "sessionFile" in run).toBe(false);
		expect(run && "artifactsDir" in run).toBe(false);
	});

	it("strips subagent_mutex extensionPath", () => {
		const event: SessionEvent = {
			type: "subagent_mutex",
			extensionPath: "/Users/secret/.pi/agent/npm/node_modules/pi-subagents",
			tools: ["subagent_task"],
		};
		const out = sanitizeSessionEvent(event);
		expect(out).toEqual({ type: "subagent_mutex", extensionPath: "", tools: ["subagent_task"] });
	});

	it("drops non-whitelist events (entry_appended / message_end / bash_execution_update)", () => {
		expect(sanitizeSessionEvent({ type: "entry_appended", entry: {} } as unknown as SessionEvent)).toBeNull();
		expect(sanitizeSessionEvent({ type: "message_end", message: {} } as unknown as SessionEvent)).toBeNull();
		expect(
			sanitizeSessionEvent({ type: "bash_execution_update", delta: "x" } as unknown as SessionEvent),
		).toBeNull();
	});

	it("passes through simple lifecycle events unchanged", () => {
		const event = { type: "agent_start" } as SessionEvent;
		expect(sanitizeSessionEvent(event)).toBe(event);
	});
});

describe("FORWARDABLE 派生自 REDUCED_EVENT_TYPES（单一事实源）", () => {
	it("白名单 = reducer 处理集 - LAN 排除项（auto_retry_* + stream_guard_tripped），增减事件类型时两侧同步", () => {
		// 经 sanitizeSessionEvent 行为探测（白名单不导出，行为即契约）：
		// reducer 处理且未被排除的类型必须通过；被排除与非 reducer 类型必须被丢弃
		const reduced = [...REDUCED_EVENT_TYPES];
		const excluded = new Set(["auto_retry_start", "auto_retry_end", "stream_guard_tripped"]);
		for (const type of reduced) {
			// 最小合成事件：载荷字段可能缺失（sanitize 内部访问会抛 TypeError）——
			// 抛错 = 白名单放行后进入转换逻辑 = 分支存在，与「被丢弃返回 null」区分
			let pass = false;
			try {
				pass = sanitizeSessionEvent({ type } as SessionEvent) != null;
			} catch {
				pass = true;
			}
			expect(pass, type).toBe(!excluded.has(type));
		}
		expect(sanitizeSessionEvent({ type: "session_info" } as SessionEvent)).toBeNull();
	});
});
