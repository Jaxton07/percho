import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { composerDocumentFromText, messagesToUIMessages } from "@percho/shared";
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

describe("会话导航索引", () => {
	it("重复读取复用不可变来源摘要，同 ID 新来源仍更新回复", () => {
		const rows = branch(2);
		const firstReply = rows[1];
		if (firstReply?.type !== "message") throw new Error("Missing assistant fixture");
		const content = (firstReply.message as { content: unknown }).content;
		let reads = 0;
		Object.defineProperty(firstReply.message, "content", {
			get: () => {
				reads++;
				return content;
			},
		});
		const pager = new SessionHistoryPager();
		const initial = pager.navigation(snapshot(rows), rows);
		const initialReads = reads;
		expect(initialReads).toBeGreaterThan(0);
		expect(pager.navigation(snapshot(rows), rows)).toEqual(initial);
		expect(reads).toBe(initialReads);
		const replaced = rows.map((item) =>
			item.id === "a0"
				? entry("a0", "u0", { role: "assistant", content: [{ type: "text", text: "New reply" }] })
				: item,
		);
		expect(pager.navigation(snapshot(replaced), replaced).entries[0]?.reply).toBe("New reply");
		expect(initial.entries[0]?.reply).toBe("Answer 0");
	});
	it("只列当前分支用户消息，沿用显示文本派生并隐藏源正文", () => {
		const rows = branch(3);
		rows[0] = {
			...rows[0],
			message: {
				...rows[0]?.message,
				content: [
					{ type: "text", text: "expanded private body" },
					{ type: "image", data: "private-image-payload", mimeType: "image/png" },
				],
				perchoInput: composerDocumentFromText("  visible\ncomposer  "),
			},
		} as SessionEntry;
		rows[4] = {
			...rows[4],
			message: {
				...rows[4]?.message,
				content: [
					{
						type: "text",
						text: '<skill name="mindmap" location="/tmp/mindmap">\nReferences are relative to /tmp/mindmap.\n\nbody\n</skill>\n\n  skill args  ',
					},
				],
			},
		} as SessionEntry;
		rows.push(entry("assistant-only", "a2", { role: "assistant", content: [{ type: "text", text: "No" }] }));
		const navigation = new SessionHistoryPager().navigation(snapshot(rows), rows);
		expect(navigation.entries).toHaveLength(3);
		expect(navigation.entries[0]?.images).toBe(1);
		expect(navigation.entries[1]?.images).toBe(0);
		expect(JSON.stringify(navigation)).not.toContain("private-image-payload");
		expect(navigation.entries.map(({ entryId, ordinal, excerpt }) => [entryId, ordinal, excerpt])).toEqual([
			["u0", 0, "visible composer"],
			["u1", 1, "Question 1"],
			["u2", 2, "skill args"],
		]);
		expect(JSON.stringify(navigation)).not.toContain("expanded private body");
		expect(JSON.stringify(navigation)).not.toContain("mindmap");
	});
	it("each round carries the first assistant text as a short reply excerpt; tool-only rounds have none", () => {
		const rows = [
			entry("u0", null, { role: "user", content: [{ type: "text", text: "Question" }] }),
			entry("a0", "u0", {
				role: "assistant",
				content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
			}),
			entry("a1", "a0", {
				role: "assistant",
				content: [{ type: "text", text: `  First\n\nreply ${"x".repeat(200)}` }],
			}),
			entry("a2", "a1", { role: "assistant", content: [{ type: "text", text: "Second reply ignored" }] }),
			entry("u1", "a2", { role: "user", content: [{ type: "text", text: "Tool only" }] }),
			entry("a3", "u1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "t2", name: "read", arguments: {} }],
			}),
		];
		const [first, second] = new SessionHistoryPager().navigation(snapshot(rows), rows).entries;
		expect(first?.reply?.startsWith("First reply x")).toBe(true);
		expect(Array.from(first?.reply ?? "")).toHaveLength(120);
		expect(second?.reply).toBeUndefined();
	});
	it("whitespace collapses and excerpts stop at 120 characters", () => {
		const rows = [
			entry("u", null, { role: "user", content: [{ type: "text", text: `  ${"x".repeat(130)}\n y ` }] }),
		];
		expect(new SessionHistoryPager().navigation(snapshot(rows), rows).entries[0]?.excerpt).toBe(
			"x".repeat(120),
		);
	});
});

describe("大历史逐页加载", () => {
	it("累计超过 24 MiB 的合法轮次可以逐页取回", () => {
		const rows = Array.from({ length: 7 }, (_, i) =>
			entry(`u${i}`, i ? `u${i - 1}` : null, {
				role: "user",
				content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }],
			}),
		);
		const view = snapshot(rows),
			pager = new SessionHistoryPager();
		let selected = pager.tail(view, rows, { hydrationToken: "open", turns: 1 }, project);
		let bytes = 0,
			pages = 0;
		while (selected.history.cursor) {
			selected = pager.older(view, rows, selected.history.cursor, { hydrationToken: "open" }, project);
			bytes += Buffer.byteLength(JSON.stringify(selected.uiMessages));
			pages++;
		}
		expect(pages).toBe(6);
		expect(bytes).toBeGreaterThan(24 * 1024 * 1024);
		expect(selected.messages[0]?.entryId).toBe("u0");
	});
});

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
