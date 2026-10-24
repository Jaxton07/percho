import { StringDecoder } from "node:string_decoder";

/** LF framing, not Unicode line splitting. Bounded until the chunk codec is added. */
export function readRuntimeFrames(onFrame: (frame: unknown) => void, onError: (error: Error) => void) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let failed = false;
	return (chunk: Buffer) => {
		if (failed) return;
		try {
			buffer += decoder.write(chunk);
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Runtime frame is too large");
				if (line.length) onFrame(JSON.parse(line));
				index = buffer.indexOf("\n");
			}
			if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("Runtime frame is too large");
		} catch (error) {
			failed = true;
			onError(error instanceof Error ? error : new Error(String(error)));
		}
	};
}
