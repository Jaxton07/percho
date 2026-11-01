// 只依赖Node及擦除类型：开发测试可由Node strip-types启动，打包时独立构建为mjs。
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import type { SessionMediaPreview } from "@percho/shared";

const MAX_LINE = 128 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MIME = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/svg+xml",
]);
const fingerprint = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
	`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

async function preview(file: string, currentVersion: number): Promise<SessionMediaPreview> {
	const before = await lstat(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink())
		throw new Error("Maintenance requires a regular, unlinked session file");
	if (before.size > 2n * 1024n * 1024n * 1024n)
		throw new Error("Session exceeds the bounded maintenance size limit");
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before))
			throw new Error("Source changed before scanning");
		const result: SessionMediaPreview = {
			supported: false,
			sourceHash: "",
			sourceFingerprint: fingerprint(before),
			fileBytes: Number(before.size),
			projectedFileBytes: 0,
			imageCount: 0,
			uniqueImages: 0,
			originalImageBytes: 0,
			backupBytes: Number(before.size),
			additionalPeakBytes: 0,
			invalidLines: 0,
			skippedImages: 0,
		};
		const hash = createHash("sha256"),
			unique = new Map<string, number>();
		let headerSeen = false,
			processed = 0,
			progressAt = 0;
		function replaceImage(value: unknown): unknown {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			const image = value as Record<string, unknown>;
			if (typeof image.data !== "string" || typeof image.mimeType !== "string") return value;
			if (!MIME.has(image.mimeType) || image.data.length > Math.ceil(MAX_IMAGE / 3) * 4 + 1024) {
				result.skippedImages++;
				return value;
			}
			const encoded = image.data.replace(/\s/g, "");
			if (!encoded || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
				result.skippedImages++;
				return value;
			}
			const bytes = Buffer.from(encoded, "base64");
			if (
				bytes.length > MAX_IMAGE ||
				bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
			) {
				result.skippedImages++;
				return value;
			}
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (!unique.has(digest)) {
				if (unique.size >= 100_000)
					throw new Error("Too many distinct images for one bounded maintenance job");
				unique.set(digest, bytes.length);
			}
			result.imageCount++;
			const replacement = { ...image };
			delete replacement.data;
			return {
				...replacement,
				kind: "reference",
				ownerSessionId: result.sessionId,
				id: `asset:${digest}`,
				revision: digest,
				byteLength: bytes.length,
			};
		}
		function line(raw: Buffer): void {
			const end = raw.at(-1) === 10 ? (raw.at(-2) === 13 ? raw.length - 2 : raw.length - 1) : raw.length;
			const body = raw.subarray(0, end),
				text = body.toString("utf8");
			result.projectedFileBytes += raw.length;
			if (!text.trim()) return;
			let row: Record<string, any>;
			try {
				row = JSON.parse(text);
			} catch {
				result.invalidLines++;
				if (!headerSeen) {
					headerSeen = true;
					result.reason = "invalid-header";
				}
				return;
			}
			if (!headerSeen) {
				headerSeen = true;
				if (
					row?.type !== "session" ||
					!Number.isInteger(row.version) ||
					typeof row.id !== "string" ||
					!/^[a-zA-Z0-9_-]{1,128}$/.test(row.id)
				) {
					result.reason = "invalid-header";
					return;
				}
				result.sourceVersion = row.version;
				result.sessionId = row.id;
				result.supported = row.version === currentVersion;
				if (!result.supported) result.reason = "unsupported-version";
				return;
			}
			if (
				!result.supported ||
				row?.type !== "message" ||
				row.message?.role !== "toolResult" ||
				row.message.toolName !== "show_image" ||
				!row.message.details ||
				typeof row.message.details !== "object" ||
				Array.isArray(row.message.details)
			)
				return;
			// 对不合法UTF-8的目标行也不重编码，避免损坏未知字段。
			if (!Buffer.from(text).equals(body)) {
				result.skippedImages++;
				return;
			}
			const details = row.message.details,
				previousCount = result.imageCount;
			if (Array.isArray(details.images)) details.images = details.images.map(replaceImage);
			else if (details.image) details.image = replaceImage(details.image);
			if (result.imageCount !== previousCount)
				result.projectedFileBytes += Buffer.byteLength(JSON.stringify(row)) - body.length;
		}
		let parts: Buffer[] = [],
			length = 0;
		for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
			const buffer = chunk as Buffer;
			hash.update(buffer);
			processed += buffer.length;
			let offset = 0;
			for (;;) {
				const newline = buffer.indexOf(10, offset),
					end = newline === -1 ? buffer.length : newline + 1;
				const piece = buffer.subarray(offset, end);
				length += piece.length;
				if (length > MAX_LINE)
					throw new Error("Session contains a line beyond the bounded maintenance limit");
				parts.push(piece);
				if (newline === -1) break;
				line(Buffer.concat(parts, length));
				parts = [];
				length = 0;
				offset = end;
				if (offset === buffer.length) break;
			}
			if (Date.now() - progressAt > 100) {
				parentPort?.postMessage({
					type: "progress",
					processedBytes: processed,
					totalBytes: result.fileBytes,
				});
				progressAt = Date.now();
			}
		}
		if (length) line(Buffer.concat(parts, length));
		if (
			fingerprint(await handle.stat({ bigint: true })) !== result.sourceFingerprint ||
			fingerprint(await lstat(file, { bigint: true })) !== result.sourceFingerprint
		)
			throw new Error("Source changed during scanning; retry preview");
		if (!headerSeen) result.reason = "invalid-header";
		result.sourceHash = hash.digest("hex");
		result.uniqueImages = unique.size;
		result.originalImageBytes = [...unique.values()].reduce((sum, n) => sum + n, 0);
		result.additionalPeakBytes = result.backupBytes + result.projectedFileBytes + result.originalImageBytes;
		if (result.supported && (!result.imageCount || result.projectedFileBytes >= result.fileBytes))
			result.reason = "no-benefit";
		return result;
	} finally {
		await handle.close();
	}
}

if (!parentPort || workerData?.kind !== "preview") throw new Error("Invalid maintenance worker invocation");
void preview(workerData.file, workerData.currentVersion).then(
	(result) => parentPort?.postMessage({ type: "result", result }),
	(error) =>
		parentPort?.postMessage({
			type: "error",
			error: error instanceof Error ? error.message : "Maintenance scan failed",
		}),
);
