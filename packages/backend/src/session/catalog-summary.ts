import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { SessionMeta } from "@percho/shared";

export type CatalogSummary =
	| { status: "valid"; meta: SessionMeta; fingerprint: string }
	| { status: "unknown" | "ambiguous"; reason: string };

/** Includes inode and ctime: size and mtime alone miss replacements and some edits. */
export function catalogFingerprint(value: Stats): string {
	return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
}

/** Extract only navigation metadata. Never retain message content in the result. */
export async function summarizeCatalogFile(
	path: string,
	cwdFallback: string,
	onLine?: (line: number) => Promise<void>,
): Promise<CatalogSummary> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	let reader: ReturnType<typeof createInterface> | undefined;
	try {
		file = await open(path, "r");
		const before = await file.stat();
		reader = createInterface({
			input: file.createReadStream({ encoding: "utf8", autoClose: false }),
			crlfDelay: Infinity,
		});
		let header: Record<string, unknown> | undefined;
		let damagedPrefix = false;
		let name: string | undefined;
		let count = 0;
		let activity = 0;
		let lineNumber = 0;
		for await (const line of reader) {
			await onLine?.(++lineNumber);
			if (!line.trim()) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line);
			} catch {
				if (!header) damagedPrefix = true;
				continue;
			}
			if (!entry || typeof entry !== "object") continue;
			if (!header) {
				if (entry.type !== "session")
					return { status: "ambiguous", reason: "first entry is not a session header" };
				header = entry;
				continue;
			}
			if (entry.type === "session_info") {
				if (entry.name != null && typeof entry.name !== "string")
					return { status: "ambiguous", reason: "invalid session name" };
				name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
			}
			if (entry.type !== "message") continue;
			count++;
			const message = entry.message as Record<string, unknown> | undefined;
			if (
				!message ||
				typeof message !== "object" ||
				!["user", "assistant"].includes(String(message.role)) ||
				!("content" in message)
			)
				continue;
			if (typeof message.content !== "string" && !Array.isArray(message.content))
				return { status: "ambiguous", reason: "invalid message content" };
			if (Array.isArray(message.content) && message.content.some((block) => block == null))
				return { status: "ambiguous", reason: "invalid message block" };
			const timestamp =
				typeof message.timestamp === "number"
					? message.timestamp
					: new Date(String(entry.timestamp)).getTime();
			if (!Number.isNaN(timestamp)) activity = Math.max(activity, timestamp);
		}
		const after = await file.stat();
		const current = await stat(path);
		const fingerprint = catalogFingerprint(before);
		if (fingerprint !== catalogFingerprint(after) || fingerprint !== catalogFingerprint(current))
			return { status: "unknown", reason: "changed during scan" };
		if (
			!header ||
			damagedPrefix ||
			typeof header.id !== "string" ||
			!header.id ||
			typeof header.timestamp !== "string"
		)
			return { status: "ambiguous", reason: "invalid session header" };
		const createdAt = new Date(header.timestamp).getTime();
		if (!Number.isFinite(createdAt) || !Number.isFinite(activity))
			return { status: "ambiguous", reason: "invalid timestamp" };
		return {
			status: "valid",
			fingerprint,
			meta: {
				sessionId: header.id,
				sessionFile: path,
				cwd: (typeof header.cwd === "string" && header.cwd) || cwdFallback,
				name,
				active: false,
				messageCount: count,
				createdAt,
				modifiedAt: activity > 0 ? activity : createdAt,
			},
		};
	} catch (error) {
		return {
			status: "unknown",
			reason: error instanceof Error ? ("code" in error ? String(error.code) : error.message) : String(error),
		};
	} finally {
		reader?.close();
		await file?.close();
	}
}
