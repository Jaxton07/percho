import { describe, expect, it } from "vitest";
import { readSessionMessagesFromContent } from "../src/session/messages";

/**
 * 压缩分割线的回放（重开会话）：磁盘上的 compaction entry 不参与模型上下文，
 * 但必须在 UI 历史里回到它当时的位置——否则重开历史会话分割线就没了。
 */

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const header = (id: string) =>
	line({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
const userEntry = (id: string, parentId: string | null, text: string, timestamp: number) =>
	line({
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	});
const compactionEntry = (id: string, parentId: string, timestamp: number) =>
	line({
		type: "compaction",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		summary: "这段是被压掉的上下文摘要",
		firstKeptEntryId: parentId,
		tokensBefore: 330_930,
		details: { readFiles: ["src/a.ts"], modifiedFiles: [] },
		fromHook: false,
	});

describe("压缩分割线回放（会话文件 → UI 历史）", () => {
	it("compaction entry 回到原位，摘要与压缩前 token 一起带出来", () => {
		const content = [
			header("s1"),
			userEntry("m1", null, "压缩前的消息", 1),
			compactionEntry("c1", "m1", 5_000),
			userEntry("m2", "c1", "压缩后的消息", 9_000),
		].join("\n");

		expect(readSessionMessagesFromContent(content)).toEqual([
			{
				role: "user",
				entryId: "m1",
				historyId: "entry:m1:0",
				text: "压缩前的消息",
				thinking: "",
				tools: [],
				images: [],
				timestamp: 1,
			},
			{
				role: "compaction",
				entryId: "c1",
				historyId: "entry:c1:0",
				timestamp: 5_000,
				summary: "这段是被压掉的上下文摘要",
				tokensBefore: 330_930,
			},
			{
				role: "user",
				entryId: "m2",
				historyId: "entry:m2:0",
				text: "压缩后的消息",
				thinking: "",
				tools: [],
				images: [],
				timestamp: 9_000,
			},
		]);
	});

	it("多次压缩 + 旧消息全留（UI 历史不裁，只有模型上下文被裁）", () => {
		const content = [
			header("s1"),
			userEntry("m1", null, "第一段", 1),
			compactionEntry("c1", "m1", 5_000),
			userEntry("m2", "c1", "第二段", 9_000),
			compactionEntry("c2", "m2", 12_000),
			userEntry("m3", "c2", "第三段", 20_000),
		].join("\n");

		expect(
			readSessionMessagesFromContent(content).map((m) => (m.role === "compaction" ? "「压缩」" : m.text)),
		).toEqual(["第一段", "「压缩」", "第二段", "「压缩」", "第三段"]);
	});

	it("timestamp 坏值的 compaction entry 退化成当前时刻，不产 NaN", () => {
		const content = [
			header("s1"),
			userEntry("m1", null, "a", 1),
			line({
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: "not-a-date",
				summary: "s",
				tokensBefore: 1,
			}),
		].join("\n");

		const divider = readSessionMessagesFromContent(content).find((m) => m.role === "compaction");
		expect(Number.isNaN(divider?.timestamp)).toBe(false);
	});
});
