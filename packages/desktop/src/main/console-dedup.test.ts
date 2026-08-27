import { describe, expect, it } from "vitest";
import { consoleSignature, createConsoleDeduper } from "./console-dedup";

describe("consoleSignature", () => {
	it("message 截 200 字符 + sourceId", () => {
		const long = "x".repeat(500);
		expect(consoleSignature(long, "src.js")).toBe(`${"x".repeat(200)}|src.js`);
		expect(consoleSignature("err", undefined)).toBe("err|");
	});
});

describe("createConsoleDeduper", () => {
	it("首次透传全量，重复静默，第 10 次出汇总", () => {
		const d = createConsoleDeduper();
		expect(d.observe("sig-a")).toEqual({ logFull: true });
		for (let i = 2; i <= 9; i++) expect(d.observe("sig-a")).toEqual({ logFull: false });
		const tenth = d.observe("sig-a");
		expect(tenth.logFull).toBe(false);
		expect(tenth.summary).toEqual({ signature: "sig-a", sinceLast: 10, total: 10 });
	});

	it("汇总后计数重新累计，下一轮阈值到达再出一条", () => {
		const d = createConsoleDeduper();
		for (let i = 0; i < 10; i++) d.observe("sig");
		for (let i = 0; i < 9; i++) expect(d.observe("sig").summary).toBeUndefined();
		expect(d.observe("sig").summary).toEqual({ signature: "sig", sinceLast: 10, total: 20 });
	});

	it("不同签名互不干扰", () => {
		const d = createConsoleDeduper();
		expect(d.observe("a").logFull).toBe(true);
		expect(d.observe("b").logFull).toBe(true);
		expect(d.observe("a")).toEqual({ logFull: false });
	});

	it("flush 补慢烧：增量 1..9 的签名也出一条，无增量不出", () => {
		const d = createConsoleDeduper();
		for (let i = 0; i < 10; i++) d.observe("burst"); // 已出过即时汇总
		for (let i = 0; i < 3; i++) d.observe("slow"); // 增量 3，不足阈值
		const summaries = d.flush();
		expect(summaries).toEqual([{ signature: "slow", sinceLast: 3, total: 3 }]);
		expect(d.flush()).toEqual([]); // 落盘后无增量
	});

	it("LRU/FIFO 上限：256 条后最旧的被逐出，再现时按首条全量落盘", () => {
		const d = createConsoleDeduper({ maxEntries: 3 });
		d.observe("s1");
		d.observe("s2");
		d.observe("s3");
		expect(d.observe("s4").logFull).toBe(true); // 逐出 s1
		const s1 = d.observe("s1");
		expect(s1.logFull).toBe(true); // s1 被逐出后重新按首条处理
		expect(d.observe("s3")).toEqual({ logFull: false }); // 仍在表内
	});
});
