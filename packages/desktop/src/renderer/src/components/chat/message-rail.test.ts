import { type ChatRow, previewExcerpt, type SessionNavigationEntry } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";

import {
	NEAR_RANGE,
	nearDistance,
	RAIL_EXCERPT_CHARS,
	type RailNode,
	railNodes,
	sameMarkers,
	turnsInView,
} from "./message-rail";

vi.mock("@percho/shared", async (importOriginal) => {
	const shared = await importOriginal<typeof import("@percho/shared")>();
	return { ...shared, previewExcerpt: vi.fn(shared.previewExcerpt) };
});

const user = (key: string, text: string, entryId?: string): ChatRow =>
	({
		kind: "message",
		key,
		message: { kind: "user", id: key, text, images: [], timestamp: 0, entryId },
		metaInGroup: false,
		showActions: true,
		streaming: false,
	}) as unknown as ChatRow;
const assistant = (key: string, text = "reply"): ChatRow =>
	({
		kind: "message",
		key,
		message: { kind: "assistant", id: key, text, thinking: "", tools: [], timestamp: 0 },
		metaInGroup: false,
		showActions: true,
		streaming: false,
	}) as unknown as ChatRow;
const meta = (key: string): ChatRow => ({ kind: "metaGroup", key, items: [] }) as unknown as ChatRow;
const nav = (entryId: string, excerpt = entryId): SessionNavigationEntry => ({
	entryId,
	ordinal: 0,
	excerpt,
	timestamp: 0,
	images: 0,
});

describe("railNodes", () => {
	it("一条用户消息一个节点；助手回复、工具组不产生节点", () => {
		const nodes = railNodes(
			[
				user("u1", "q1", "e1"),
				meta("m1"),
				assistant("a1"),
				assistant("a1b"),
				user("u2", "q2", "e2"),
				meta("m2"),
			],
			null,
		);
		expect(nodes.map((node) => [node.key, node.index])).toEqual([
			["u1", 0],
			["u2", 4],
		]);
	});

	it("摘要去 Markdown、折叠空白并截断；回复取本轮第一段有正文的助手消息", () => {
		const long = `a\n\n  b ${"x".repeat(200)}`;
		const nodes = railNodes(
			[
				user("u1", long, "e1"),
				assistant("a0", "  "),
				assistant("a1", "**first**"),
				assistant("a2", "second"),
			],
			null,
		);
		expect(nodes[0]?.excerpt.startsWith("a b x")).toBe(true);
		expect(nodes[0]?.excerpt).toHaveLength(RAIL_EXCERPT_CHARS);
		expect(nodes[0]?.reply).toBe("first");
	});

	it("服务端索引只补「早于已加载首条」的未加载部分，已加载部分以行为准", () => {
		const rows = [user("u3", "third", "e3"), assistant("a3"), user("u4", "live, not yet in index")];
		const nodes = railNodes(rows, [nav("e1", "first"), nav("e2", "second"), nav("e3", "stale excerpt")]);
		expect(nodes.map((node) => [node.key, node.index, node.entryId])).toEqual([
			["nav:e1", -1, "e1"],
			["nav:e2", -1, "e2"],
			["u3", 0, "e3"],
			["u4", 2, undefined],
		]);
		expect(nodes[2]?.excerpt).toBe("third");
	});

	it("前插、同文本不同来源和重装换代时保持预览归属", () => {
		const first = user("u1", "**same**", "e1");
		const second = user("u2", "**same**", "e2");
		const rows = [first, assistant("a1", "first reply"), second, assistant("a2", "second reply")];
		expect(railNodes(rows, null).map((node) => [node.key, node.excerpt, node.reply])).toEqual([
			["u1", "same", "first reply"],
			["u2", "same", "second reply"],
		]);
		expect(railNodes([user("u0", "earlier", "e0"), ...rows], null).map((node) => node.index)).toEqual([
			0, 1, 3,
		]);
		const replaced = railNodes([user("u1", "new branch", "e1"), assistant("a1", "new reply")], null);
		expect(replaced[0]).toMatchObject({ key: "u1", excerpt: "new branch", reply: "new reply" });
		expect(railNodes(rows, null)[0]?.reply).toBe("first reply");
	});

	it("服务端摘要原样使用，不再次去除其内容", () => {
		const entries = [
			{ ...nav("e1", "literal * and ` characters"), reply: "literal ** and [text]" },
			nav("e2"),
		];
		expect(railNodes([user("u2", "loaded", "e2")], entries)[0]).toMatchObject({
			excerpt: "literal * and ` characters",
			reply: "literal ** and [text]",
		});
	});

	it("流式增量只格式化新回复，不重复处理千轮稳定历史", () => {
		const rows = Array.from({ length: 1000 }, (_, i) => [
			user(`u${i}`, `question ${i}`),
			assistant(`a${i}`),
		]).flat();
		const active = user("active", "latest question");
		vi.mocked(previewExcerpt).mockClear();
		railNodes([...rows, active], null);
		expect(previewExcerpt).toHaveBeenCalledTimes(2001);
		vi.mocked(previewExcerpt).mockClear();
		for (let i = 0; i < 150; i++) {
			const nodes = railNodes([...rows, active, assistant("stream", `**reply ${i}**`)], null);
			expect(nodes.at(-1)?.reply).toBe(`reply ${i}`);
		}
		expect(previewExcerpt).toHaveBeenCalledTimes(150);
		const withFirstReply = railNodes(
			[...rows, active, assistant("done", "first"), assistant("stream", "later")],
			null,
		);
		expect(withFirstReply.at(-1)?.reply).toBe("first");
	});

	it("索引里找不到已加载首条（过期/错位）时不补未加载节点", () => {
		const nodes = railNodes([user("u9", "x", "e9")], [nav("e1"), nav("e2")]);
		expect(nodes.map((node) => node.key)).toEqual(["u9"]);
	});
});

describe("sameMarkers", () => {
	it("只比较刻度身份：流式输出只改摘要时视为未变化", () => {
		const a: RailNode[] = [{ key: "u1", excerpt: "q", index: 0 }];
		const b: RailNode[] = [{ key: "u1", excerpt: "q", reply: "streaming…", index: 0 }];
		expect(sameMarkers(a, b)).toBe(true);
		expect(sameMarkers(a, [...b, { key: "u2", excerpt: "q2", index: 3 }])).toBe(false);
		expect(sameMarkers(a, [{ key: "u9", excerpt: "q", index: 0 }])).toBe(false);
		expect(sameMarkers(a, [{ key: "u1", excerpt: "changed", index: 0 }])).toBe(false);
		expect(sameMarkers(a, [{ key: "u1", excerpt: "q", index: -1 }])).toBe(false);
	});
});

describe("turnsInView", () => {
	// 行：u0 a0 m0 | u1 a1 | u2 a2 a2b
	const nodes = railNodes(
		[
			user("u0", "a", "e0"),
			assistant("a0"),
			meta("m0"),
			user("u1", "b", "e1"),
			assistant("a1"),
			user("u2", "c", "e2"),
			assistant("a2"),
			assistant("a2b"),
		],
		[nav("old"), nav("e0")],
	);
	it("视口内的每一行归属到它前面最近的用户消息；跨多轮时返回区间（允许多条同时高亮）", () => {
		expect(turnsInView(nodes, 0, 2)).toEqual({ from: 1, to: 1 });
		expect(turnsInView(nodes, 1, 4)).toEqual({ from: 1, to: 2 });
		expect(turnsInView(nodes, 2, 7)).toEqual({ from: 1, to: 3 });
		expect(turnsInView(nodes, 6, 7)).toEqual({ from: 3, to: 3 });
	});
	it("视口在首条已加载用户消息之前时归到第一个已加载节点；没有已加载节点时为 null", () => {
		expect(turnsInView(nodes, -1, -1)).toEqual({ from: 1, to: 1 });
		expect(turnsInView([{ key: "nav:x", excerpt: "x", index: -1 }], 0, 3)).toBeNull();
	});
});

describe("nearDistance", () => {
	it("只在悬停时有值：距离 0–3，超出或未悬停为 undefined", () => {
		expect([0, 1, 2, 3, 4].map((i) => nearDistance(i, 0))).toEqual([0, 1, 2, 3, undefined]);
		expect(nearDistance(5, 8)).toBe(3);
		expect(nearDistance(5, null)).toBeUndefined();
		expect(NEAR_RANGE).toBe(3);
	});
});
