import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const RUNTIME_MESSAGE_BYTES = 64 * 1024 * 1024;
const BUFFER_BYTES = 96 * 1024 * 1024;
const CHUNK_BYTES = 48 * 1024;
const FRAME_BYTES = 1024 * 1024;
const MAX_MESSAGES = 128;
interface Assembly {
	bytes: number;
	total: number;
	parts: Buffer[];
	timer: ReturnType<typeof setTimeout>;
}

/** Only complete logical messages reach business code. Control frames may pass between chunks. */
export function readRuntimeFrames(onFrame: (frame: unknown) => void, onError: (error: Error) => void) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let failed = false;
	let reserved = 0;
	const assemblies = new Map<string, Assembly>();
	const dispose = () => {
		failed = true;
		buffer = "";
		for (const entry of assemblies.values()) clearTimeout(entry.timer);
		assemblies.clear();
		reserved = 0;
	};
	const fail = (error: unknown) => {
		if (failed) return;
		dispose();
		onError(error instanceof Error ? error : new Error(String(error)));
	};
	const accept = (frame: unknown) => {
		if (!frame || typeof frame !== "object" || !("type" in frame) || frame.type !== "chunk") {
			onFrame(frame);
			return;
		}
		const part = frame as Record<string, unknown>;
		if (
			typeof part.id !== "string" ||
			!part.id ||
			part.id.length > 128 ||
			!Number.isSafeInteger(part.index) ||
			!Number.isSafeInteger(part.total) ||
			!Number.isSafeInteger(part.bytes) ||
			(part.bytes as number) < 1 ||
			(part.bytes as number) > RUNTIME_MESSAGE_BYTES ||
			part.total !== Math.ceil((part.bytes as number) / CHUNK_BYTES) ||
			typeof part.data !== "string" ||
			part.data.length > (CHUNK_BYTES * 4) / 3 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)
		)
			throw new Error("Invalid runtime message chunk");
		let entry = assemblies.get(part.id);
		if (!entry) {
			if (part.index !== 0 || assemblies.size >= 4 || reserved + (part.bytes as number) > BUFFER_BYTES)
				throw new Error("Runtime assembly capacity exceeded");
			entry = {
				bytes: part.bytes as number,
				total: part.total as number,
				parts: [],
				timer: setTimeout(() => fail(new Error("Runtime message transfer timed out")), 30_000),
			};
			entry.timer.unref();
			assemblies.set(part.id, entry);
			reserved += entry.bytes;
		}
		if (part.index !== entry.parts.length || part.total !== entry.total || part.bytes !== entry.bytes)
			throw new Error("Runtime chunk sequence mismatch");
		const bytes = Buffer.from(part.data, "base64");
		const expected = Math.min(CHUNK_BYTES, entry.bytes - entry.parts.length * CHUNK_BYTES);
		if (bytes.length !== expected || bytes.toString("base64") !== part.data)
			throw new Error("Runtime chunk length mismatch");
		entry.parts.push(bytes);
		if (entry.parts.length === entry.total) {
			assemblies.delete(part.id);
			reserved -= entry.bytes;
			clearTimeout(entry.timer);
			const message = JSON.parse(Buffer.concat(entry.parts, entry.bytes).toString("utf8"));
			if (message?.type === "chunk") throw new Error("Nested runtime chunks are not allowed");
			onFrame(message);
		}
	};
	const receive = (chunk: Buffer) => {
		if (failed) return;
		try {
			buffer += decoder.write(chunk);
			let index = buffer.indexOf("\n");
			while (index >= 0 && !failed) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (Buffer.byteLength(line) > FRAME_BYTES) throw new Error("Runtime frame is too large");
				if (line.length) accept(JSON.parse(line));
				index = buffer.indexOf("\n");
			}
			if (Buffer.byteLength(buffer) > FRAME_BYTES) throw new Error("Runtime frame is too large");
		} catch (error) {
			fail(error);
		}
	};
	return Object.assign(receive, { dispose });
}

interface Outgoing {
	bytes: Buffer;
	offset: number;
	id: string;
}
/** Bounded FIFO business messages; small control messages can interrupt a transfer. */
export class RuntimeWriter {
	private readonly normal: Outgoing[] = [];
	private readonly controls: Outgoing[] = [];
	private queuedBytes = 0;
	private scheduled = false;
	private closed = false;
	constructor(private readonly stream: Writable) {
		stream.once("close", () => this.dispose());
		stream.on("drain", () => this.schedule());
	}
	dispose(): void {
		this.closed = true;
		this.normal.length = this.controls.length = 0;
		this.queuedBytes = 0;
	}
	write(value: unknown, priority = false): void {
		this.writeEncoded(JSON.stringify(value), priority);
	}
	writeEncoded(encoded: string, priority = false): void {
		if (this.closed || this.stream.destroyed || !this.stream.writable)
			throw new Error("Runtime connection is closed");
		const bytes = Buffer.from(encoded);
		if (bytes.length > RUNTIME_MESSAGE_BYTES) throw new Error("Runtime message exceeds 64 MiB limit");
		if (
			this.queuedBytes + bytes.length > BUFFER_BYTES ||
			this.normal.length + this.controls.length >= MAX_MESSAGES
		)
			throw new Error("Runtime outgoing buffer capacity exceeded");
		if (priority && bytes.length > CHUNK_BYTES) throw new Error("Runtime control message is too large");
		(priority ? this.controls : this.normal).push({ bytes, offset: 0, id: randomUUID() });
		this.queuedBytes += bytes.length;
		this.schedule();
	}
	private schedule(): void {
		if (this.closed || this.scheduled || this.stream.writableNeedDrain) return;
		this.scheduled = true;
		setImmediate(() => {
			this.scheduled = false;
			this.flush();
		});
	}
	private flush(): void {
		if (this.closed || this.stream.destroyed) return;
		const queue = this.controls.length ? this.controls : this.normal;
		const next = queue[0];
		if (!next) return;
		let line: string;
		if (next.bytes.length <= CHUNK_BYTES) {
			line = `${next.bytes.toString("utf8")}\n`;
			next.offset = next.bytes.length;
		} else {
			line = `${JSON.stringify({
				type: "chunk",
				id: next.id,
				index: next.offset / CHUNK_BYTES,
				total: Math.ceil(next.bytes.length / CHUNK_BYTES),
				bytes: next.bytes.length,
				data: next.bytes.subarray(next.offset, next.offset + CHUNK_BYTES).toString("base64"),
			})}\n`;
			next.offset = Math.min(next.bytes.length, next.offset + CHUNK_BYTES);
		}
		if (next.offset === next.bytes.length) {
			queue.shift();
			this.queuedBytes -= next.bytes.length;
		}
		try {
			this.stream.write(line);
			this.schedule();
		} catch (error) {
			this.dispose();
			this.stream.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	}
}
