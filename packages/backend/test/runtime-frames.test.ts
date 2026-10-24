import { describe, expect, it, vi } from "vitest";
import { readRuntimeFrames } from "../src/runtime/frames";

describe("runtime framing", () => {
	it("preserves split UTF-8, escaped newlines and Unicode line separators; only LF frames messages", () => {
		const receive = vi.fn();
		const fail = vi.fn();
		const input = readRuntimeFrames(receive, fail);
		const bytes = Buffer.from(
			`${JSON.stringify({ text: "远端\n输出\u2028继续\u2029完成" })}\r\n${JSON.stringify({ next: true })}\n`,
		);
		for (const byte of bytes) input(Buffer.from([byte]));
		expect(receive.mock.calls).toEqual([[{ text: "远端\n输出\u2028继续\u2029完成" }], [{ next: true }]]);
		expect(fail).not.toHaveBeenCalled();
	});
	it("rejects malformed and oversized frames once, discarding subsequent input", () => {
		for (const value of ["{invalid}\n", "x".repeat(1024 * 1024 + 1)]) {
			const receive = vi.fn();
			const fail = vi.fn();
			const input = readRuntimeFrames(receive, fail);
			input(Buffer.from(value));
			input(Buffer.from('{"after":true}\n'));
			expect(fail).toHaveBeenCalledTimes(1);
			expect(receive).not.toHaveBeenCalled();
		}
	});
});
