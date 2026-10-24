import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RuntimeWriter, readRuntimeFrames } from "../src/runtime/frames";

describe("runtime framing", () => {
	it("round trips multiple large image payloads with fragmented bytes while a heartbeat overtakes the transfer", async () => {
		const received: unknown[] = [];
		const failure = vi.fn();
		const reader = readRuntimeFrames((frame) => received.push(frame), failure);
		let writer!: RuntimeWriter;
		let frames = 0;
		const sink = new Writable({
			write(chunk: Buffer, _encoding, done) {
				for (let index = 0; index < chunk.length; index += 997) reader(chunk.subarray(index, index + 997));
				if (++frames === 1) writer.write({ type: "ping", nonce: "during-images" }, true);
				setTimeout(done, 1);
			},
		});
		writer = new RuntimeWriter(sink);
		const payload = {
			type: "event",
			text: "远端\u2028图片",
			images: Array.from({ length: 3 }, () => ({ data: "a".repeat(2 * 1024 * 1024), mimeType: "image/png" })),
		};
		try {
			writer.write(payload);
			await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 10000 });
			expect(received[0]).toEqual({ type: "ping", nonce: "during-images" });
			expect(received[1]).toEqual(payload);
			expect(failure).not.toHaveBeenCalled();
		} finally {
			writer.dispose();
			reader.dispose();
			sink.destroy();
		}
	});
	it("bounds a stalled writer and discards cancelled/invalid partial messages", async () => {
		const stalled = new Writable({ write() {} });
		const writer = new RuntimeWriter(stalled);
		try {
			for (let i = 0; i < 128; i++) writer.write({ id: i });
			expect(() => writer.write({ extra: true })).toThrow("capacity");
			writer.dispose();
			expect(() => writer.write({ after: true })).toThrow("closed");
		} finally {
			stalled.destroy();
		}
		const receive = vi.fn(),
			fail = vi.fn();
		const reader = readRuntimeFrames(receive, fail);
		const first = {
			type: "chunk",
			id: "partial",
			index: 0,
			total: 2,
			bytes: 49153,
			data: Buffer.alloc(49152).toString("base64"),
		};
		reader(Buffer.from(`${JSON.stringify(first)}\n`));
		expect(receive).not.toHaveBeenCalled();
		reader(Buffer.from(`${JSON.stringify(first)}\n`));
		expect(fail).toHaveBeenCalledOnce();
		reader.dispose();
		expect(receive).not.toHaveBeenCalled();
	});
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
