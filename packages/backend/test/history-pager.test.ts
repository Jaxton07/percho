import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { messagesToUIMessages } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { SessionHistoryPager } from "../src/session/history-pager";
import { toBranchSessionMessages } from "../src/session/messages";
import type { SourceSnapshot } from "../src/session/source-snapshot";

const entry = (id: string, parentId: string | null, message: Record<string, unknown>): SessionEntry =>
	({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		message: { ...message, timestamp: 1 },
	}) as SessionEntry;
function branch(turns: number) {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < turns; i++) {
		entries.push(
			entry(`u${i}`, entries.at(-1)?.id ?? null, {
				role: "user",
				content: [{ type: "text", text: `Question ${i}` }],
			}),
		);
		entries.push(
			entry(`a${i}`, `u${i}`, { role: "assistant", content: [{ type: "text", text: `Answer ${i}` }] }),
		);
	}
	return entries;
}
function snapshot(entries: SessionEntry[]): SourceSnapshot {
	return {
		owner: "source",
		version: "version",
		fingerprint: null,
		branch: entries,
		entries,
		byId: new Map(entries.map((entry) => [entry.id, entry])),
		entryCount: entries.length,
		readOnly: false,
		shareable: true,
		pending: new Map(),
		pendingKeys: new WeakMap(),
	};
}
const context = { hydrationToken: "open-one" };
const project = (entries: readonly SessionEntry[]) => toBranchSessionMessages(entries, "source");

describe("先选原始完整轮次再投影", () => {
	it("同叶及分页边界ID不变时，祖先链改变也必须拒绝旧游标", () => {
		const rows = branch(8),
			pager = new SessionHistoryPager();
		const project = (entries: readonly SessionEntry[]) => toBranchSessionMessages(entries, "source");
		const tail = pager.tail(snapshot(rows), rows, { hydrationToken: "open", turns: 2 }, project);
		const changed = [...rows];
		changed[0] = { ...rows[0], id: "alternate-root" } as SessionEntry;
		changed[1] = { ...rows[1], parentId: "alternate-root" } as SessionEntry;
		const cursor = tail.history.cursor;
		if (!cursor) throw new Error("Expected an older history page");
		expect(() =>
			pager.older(snapshot(changed), changed, cursor, { hydrationToken: "open" }, project),
		).toThrow("HISTORY_CURSOR_INVALID");
	});
	it("万条文本首次仅投影80条；所有页按稳定身份重建等于完整历史", () => {
		const entries = branch(5000),
			source = snapshot(entries),
			pager = new SessionHistoryPager();
		let selected = pager.tail(source, entries, { ...context, turns: 40 }, project),
			messages = selected.uiMessages;
		expect(pager.stats()).toMatchObject({ indexEntries: 0, projectedEntries: 80 });
		expect(selected.history.pageTurns).toBe(40);
		expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(256 * 1024);
		let pages = 1;
		while (selected.history.cursor) {
			selected = pager.older(source, entries, selected.history.cursor, context, project);
			messages = [...selected.uiMessages, ...messages];
			pages++;
		}
		expect(messages).toEqual(messagesToUIMessages(project(entries)));
		expect(pages).toBe(125);
		expect(pager.stats()).toMatchObject({ indexEntries: 0, projectedEntries: 10000 });
	});
	it("前导无user段不丢，大单轮可无损返回，标准目标只减少完整轮次", () => {
		const compact = {
			type: "compaction",
			id: "compact",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			summary: "Prefix",
			tokensBefore: 10,
		} as SessionEntry;
		const rows = branch(3);
		rows[0] = { ...rows[0], parentId: "compact" } as SessionEntry;
		const entries = [compact, ...rows],
			view = snapshot(entries),
			pager = new SessionHistoryPager();
		const last = pager.tail(view, entries, { ...context, turns: 3 }, project);
		expect(last.history.hasOlder).toBe(true);
		const cursor = last.history.cursor;
		if (!cursor) throw new Error("No prefix cursor");
		expect(pager.older(view, entries, cursor, context, project).uiMessages[0]?.id).toBe(
			"entry:source:compact:0",
		);
		const giant = [
				entry("huge", null, { role: "user", content: [{ type: "text", text: "x".repeat(300000) }] }),
			],
			before = JSON.stringify(giant);
		expect(pager.tail(snapshot(giant), giant, context, project).uiMessages[0]).toMatchObject({
			text: "x".repeat(300000),
		});
		expect(JSON.stringify(giant)).toBe(before);
		const medium = branch(10).map((row) =>
			row.type === "message"
				? ({
						...row,
						message: { ...row.message, content: [{ type: "text", text: "x".repeat(20000) }] },
					} as SessionEntry)
				: row,
		);
		const small = pager.tail(snapshot(medium), medium, { ...context, turns: 10 }, project);
		expect(small.history.pageTurns).toBeLessThan(10);
		expect(small.history.hasOlder).toBe(true);
	});
	it("超过既有64MiB逻辑消息上限的整轮明确失败，不提高传输预算", () => {
		const oversized = [
			entry("too-large", null, {
				role: "user",
				content: [{ type: "text", text: "x".repeat(65 * 1024 * 1024) }],
			}),
		];
		expect(() => new SessionHistoryPager().tail(snapshot(oversized), oversized, context, project)).toThrow(
			"HISTORY_PAGE_TOO_LARGE",
		);
	});
	it("跨user边界的工具结果向前扩到调用整轮，不能丢图或把调用/结果拆成两页", () => {
		const entries = [
			entry("u0", null, { role: "user", content: [{ type: "text", text: "Start" }] }),
			entry("a0", "u0", {
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "show_image", arguments: { paths: ["image.png"] } }],
			}),
			entry("u1", "a0", { role: "user", content: [{ type: "text", text: "Steering" }] }),
			entry("result", "u1", {
				role: "toolResult",
				toolCallId: "call",
				toolName: "show_image",
				content: [{ type: "text", text: "Done" }],
				details: { images: [{ data: "AQID", mimeType: "image/png" }] },
			}),
		];
		const page = new SessionHistoryPager().tail(
			snapshot(entries),
			entries,
			{ ...context, turns: 1 },
			project,
		);
		expect(page.history.hasOlder).toBe(false);
		expect(page.history.pageTurns).toBe(2);
		expect(page.uiMessages.some((message) => message.kind === "image")).toBe(true);
	});
	it("同分支追加可前插；分支/来源/open实例变化拒绝旧游标", () => {
		const entries = branch(3),
			view = snapshot(entries),
			pager = new SessionHistoryPager(),
			tail = pager.tail(view, entries, { ...context, turns: 1 }, project),
			cursor = tail.history.cursor;
		if (!cursor) throw new Error("No cursor");
		const added = [
			entry("u3", "a2", { role: "user", content: [{ type: "text", text: "New" }] }),
			entry("a3", "u3", { role: "assistant", content: [{ type: "text", text: "New reply" }] }),
		];
		view.branch = [...entries, ...added];
		for (const row of added) view.byId.set(row.id, row);
		expect(pager.older(view, view.branch, cursor, context, project).uiMessages[0]?.id).toBe(
			"entry:source:u1:0",
		);
		expect(() => pager.older(view, view.branch, cursor, { hydrationToken: "open-two" }, project)).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
		view.version = "new-version";
		expect(() => pager.older(view, view.branch, cursor, context, project)).toThrow("source");
		view.version = "version";
		view.branch = entries.slice(0, 4);
		expect(() => pager.older(view, view.branch, cursor, context, project)).toThrow("branch");
	});
	it("活动anchor外的SDK记录不进入历史页，游标仍识别完整branch", () => {
		const entries = branch(4),
			view = snapshot(entries),
			prefix = entries.slice(0, 6),
			pager = new SessionHistoryPager();
		const tail = pager.tail(view, prefix, { ...context, turns: 1 }, project),
			cursor = tail.history.cursor;
		if (!cursor) throw new Error("No cursor");
		expect(tail.uiMessages.map((message) => message.id)).toEqual(["entry:source:u2:0", "entry:source:a2:0"]);
		expect(
			pager.older(view, prefix, cursor, context, project).uiMessages.map((message) => message.id),
		).toEqual(["entry:source:u1:0", "entry:source:a1:0"]);
	});
});
