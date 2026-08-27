import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../src/log";

/** sweepOldLogs 的文件名过滤正则（实现内联常量，这里镜像断言其不变量） */
const LOG_FILENAME_RE = /^main-\d{4}-\d{2}-\d{2}\.log$/;

/** 由 getTimezoneOffset 推导的期望偏移尾缀（±HH:MM） */
function expectedOffset(d: Date): string {
	const offsetMin = d.getTimezoneOffset();
	const sign = offsetMin <= 0 ? "+" : "-";
	const abs = Math.abs(offsetMin);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

describe("formatTimestamp", () => {
	it("格式 = 本地时间 + ±HH:MM 偏移尾缀（契约正则）", () => {
		const ts = formatTimestamp(new Date());
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
	});

	it("各字段与 Date 本地 getter 一致（毫秒 3 位补零）", () => {
		const d = new Date(2026, 7, 27, 4, 39, 29, 29); // 本地 2026-08-27 04:39:29.029
		const ts = formatTimestamp(d);
		expect(ts.startsWith("2026-08-27T04:39:29.029")).toBe(true);
	});

	it("偏移尾缀换算正确（getTimezoneOffset → ±HH:MM，含 UTC+0 边界）", () => {
		const d = new Date(Date.UTC(2026, 0, 2, 12, 0, 0)); // 任意本机时区下的确定时刻
		expect(formatTimestamp(d).endsWith(expectedOffset(d))).toBe(true);
		// offset 为 0 时必须是 +00:00（不是 -00:00）
		const zero = new Date();
		if (zero.getTimezoneOffset() === 0) {
			expect(formatTimestamp(zero).endsWith("+00:00")).toBe(true);
		}
	});

	it("文件名日期（本地）仍匹配 sweepOldLogs 的 main-<date>.log 正则", () => {
		const d = new Date(2026, 7, 27, 4, 39, 29, 29);
		const filename = `main-${formatTimestamp(d).slice(0, 10)}.log`;
		expect(filename).toBe("main-2026-08-27.log");
		expect(LOG_FILENAME_RE.test(filename)).toBe(true);
	});
});
