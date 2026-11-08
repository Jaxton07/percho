import { open, stat } from "node:fs/promises";
import type { SessionMeta } from "@percho/shared";
// @ts-expect-error Node requires the extension for source workers.
import { catalogFingerprint } from "./catalog-summary.ts";

export async function readSessionHeader(
	path: string,
	onRead?: (bytes: number) => void,
): Promise<
	| {
			status: "valid";
			meta: Omit<SessionMeta, "messageCount"> & { messageCount?: number };
			fingerprint: string;
	  }
	| { status: "unknown" | "ambiguous"; reason: string }
> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, "r");
		const before = await file.stat();
		const buffer = Buffer.alloc(64 * 1024);
		let length = 0;
		let end = -1;
		while (length < buffer.length && end < 0) {
			const { bytesRead } = await file.read(buffer, length, Math.min(4096, buffer.length - length), length);
			onRead?.(bytesRead);
			if (!bytesRead) break;
			end = buffer.indexOf(10, length);
			length += bytesRead;
		}
		const fingerprint = catalogFingerprint(before);
		if (
			fingerprint !== catalogFingerprint(await file.stat()) ||
			fingerprint !== catalogFingerprint(await stat(path))
		)
			return { status: "unknown", reason: "changed during header read" };
		if (end < 0 && length < before.size)
			return { status: "ambiguous", reason: "session header exceeds limit" };
		let header: unknown;
		try {
			header = JSON.parse(buffer.subarray(0, end < 0 ? length : end).toString("utf8"));
		} catch {
			return { status: "ambiguous", reason: "invalid session header" };
		}
		if (!header || typeof header !== "object" || Array.isArray(header))
			return { status: "ambiguous", reason: "invalid session header" };
		const h = header as Record<string, unknown>;
		const createdAt = typeof h.timestamp === "string" ? new Date(h.timestamp).getTime() : NaN;
		if (h.type !== "session" || typeof h.id !== "string" || !h.id || !Number.isFinite(createdAt))
			return { status: "ambiguous", reason: "invalid session header" };
		if (typeof h.cwd !== "string" || !h.cwd.trim()) return { status: "ambiguous", reason: "Missing cwd" };
		return {
			status: "valid",
			fingerprint,
			meta: { sessionId: h.id, sessionFile: path, cwd: h.cwd, active: false, createdAt },
		};
	} catch (error) {
		return {
			status: "unknown",
			reason: error instanceof Error ? ("code" in error ? String(error.code) : error.message) : String(error),
		};
	} finally {
		await file?.close();
	}
}
