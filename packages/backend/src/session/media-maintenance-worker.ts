// 仅Node与擦除类型。源码可strip-types运行，桌面/远端另构建独立mjs，不加载SDK运行上下文。
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, copyFile, lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { SessionMediaPreview } from "@percho/shared";

const MAX_LINE = 128 * 1024 * 1024,
	MAX_IMAGE = 10 * 1024 * 1024;
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
let nextRequest = 0;
async function request<T>(type: string, payload: unknown): Promise<T> {
	const port = parentPort;
	if (!port) throw new Error("Missing maintenance coordinator");
	const requestId = ++nextRequest;
	return new Promise((resolve, reject) => {
		const receive = (message: { requestId?: number; value?: T; error?: string }) => {
			if (message.requestId !== requestId) return;
			port.off("message", receive);
			if (message.error) reject(new Error(message.error));
			else resolve(message.value as T);
		};
		port.on("message", receive);
		port.postMessage({ type, payload, requestId });
	});
}
async function regular(file: string) {
	const stat = await lstat(file, { bigint: true });
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("Maintenance requires a regular, unlinked file");
	if (stat.size > 2n * 1024n * 1024n * 1024n)
		throw new Error("Session exceeds the bounded maintenance size limit");
	return stat;
}
async function hashFile(file: string) {
	const before = await regular(file),
		handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before))
			throw new Error("Source changed before hashing");
		const hash = createHash("sha256");
		for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }))
			hash.update(chunk);
		if (
			fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before) ||
			fingerprint(await regular(file)) !== fingerprint(before)
		)
			throw new Error("Source changed while hashing");
		return { hash: hash.digest("hex"), fingerprint: fingerprint(before), bytes: Number(before.size) };
	} finally {
		await handle.close();
	}
}
async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const result = await file.write(bytes, offset, bytes.length - offset);
		if (!result.bytesWritten) throw new Error("Short maintenance write");
		offset += result.bytesWritten;
	}
}
async function* rawLines(handle: FileHandle) {
	let parts: Buffer[] = [],
		size = 0;
	for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
		const buffer = chunk as Buffer;
		let offset = 0;
		for (;;) {
			const newline = buffer.indexOf(10, offset),
				end = newline < 0 ? buffer.length : newline + 1;
			const piece = buffer.subarray(offset, end);
			size += piece.length;
			if (size > MAX_LINE) throw new Error("Session contains a line beyond the bounded maintenance limit");
			parts.push(piece);
			if (newline < 0) break;
			const line = Buffer.concat(parts, size);
			parts = [];
			size = 0;
			offset = end;
			yield line;
			if (offset === buffer.length) break;
		}
	}
	if (size) {
		const line = Buffer.concat(parts, size);
		parts = [];
		yield line;
	}
}

async function scan(
	file: string,
	currentVersion: number,
	writer?: FileHandle,
	verifyAssets = false,
): Promise<SessionMediaPreview & { outputHash: string }> {
	const before = await regular(file),
		identity = fingerprint(before);
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (fingerprint(await handle.stat({ bigint: true })) !== identity)
			throw new Error("Source changed before scanning");
		const result: SessionMediaPreview = {
			supported: false,
			sourceHash: "",
			sourceFingerprint: identity,
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
			outputHash = createHash("sha256"),
			unique = new Map<string, number>(),
			verified = new Set<string>();
		let headerSeen = false,
			processed = 0,
			progressAt = 0;
		async function image(value: unknown): Promise<unknown> {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			const original = value as Record<string, unknown>;
			if (typeof original.data !== "string" || typeof original.mimeType !== "string") {
				if ((writer || verifyAssets) && original.kind === "reference") {
					const key = `${original.id}:${original.revision}`;
					if (!verified.has(key)) {
						if (verified.size >= 100_000) throw new Error("Too many asset references");
						await request("verify", { id: original.id, revision: original.revision });
						verified.add(key);
					}
				}
				return value;
			}
			if (!MIME.has(original.mimeType) || original.data.length > Math.ceil(MAX_IMAGE / 3) * 4 + 1024) {
				result.skippedImages++;
				return value;
			}
			const encoded = original.data.replace(/\s/g, "");
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
			const replacement = { ...original };
			delete replacement.data;
			const reference = writer
				? await request<Record<string, unknown>>("asset", { bytes, digest, mimeType: original.mimeType })
				: {
						kind: "reference",
						ownerSessionId: result.sessionId,
						id: `asset:${digest}`,
						revision: digest,
						byteLength: bytes.length,
					};
			return { ...replacement, ...reference };
		}
		async function convert(raw: Buffer): Promise<Buffer> {
			const end = raw.at(-1) === 10 ? (raw.at(-2) === 13 ? raw.length - 2 : raw.length - 1) : raw.length;
			const body = raw.subarray(0, end),
				text = body.toString("utf8");
			if (!text.trim()) return raw;
			let row: Record<string, any>;
			try {
				row = JSON.parse(text);
			} catch {
				result.invalidLines++;
				if (!headerSeen) {
					headerSeen = true;
					result.reason = "invalid-header";
				}
				return raw;
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
					return raw;
				}
				result.sourceVersion = row.version;
				result.sessionId = row.id;
				result.supported = row.version === currentVersion;
				if (!result.supported) result.reason = "unsupported-version";
				return raw;
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
				return raw;
			if (!Buffer.from(text).equals(body)) {
				result.skippedImages++;
				return raw;
			}
			const details = row.message.details,
				previousCount = result.imageCount;
			if (Array.isArray(details.images)) {
				const images = [];
				for (const value of details.images) images.push(await image(value));
				details.images = images;
			} else if (details.image) details.image = await image(details.image);
			return result.imageCount === previousCount
				? raw
				: Buffer.concat([Buffer.from(JSON.stringify(row)), raw.subarray(end)]);
		}
		for await (const raw of rawLines(handle)) {
			hash.update(raw);
			processed += raw.length;
			const output = await convert(raw);
			outputHash.update(output);
			result.projectedFileBytes += output.length;
			if (writer) await writeAll(writer, output);
			if (Date.now() - progressAt > 100) {
				parentPort?.postMessage({
					type: "progress",
					processedBytes: processed,
					totalBytes: result.fileBytes,
				});
				progressAt = Date.now();
			}
		}
		if (
			fingerprint(await handle.stat({ bigint: true })) !== identity ||
			fingerprint(await regular(file)) !== identity
		)
			throw new Error("Source changed during scanning; retry preview");
		if (!headerSeen) result.reason = "invalid-header";
		result.sourceHash = hash.digest("hex");
		result.uniqueImages = unique.size;
		result.originalImageBytes = [...unique.values()].reduce((sum, bytes) => sum + bytes, 0);
		result.additionalPeakBytes = result.backupBytes + result.projectedFileBytes + result.originalImageBytes;
		if (result.supported && (!result.imageCount || result.projectedFileBytes >= result.fileBytes))
			result.reason = "no-benefit";
		return { ...result, outputHash: outputHash.digest("hex") };
	} finally {
		await handle.close();
	}
}

async function syncFile(file: string) {
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function prepare(data: {
	file: string;
	currentVersion: number;
	expectedHash: string;
	backup: string;
	candidate: string;
}) {
	const preview = await scan(data.file, data.currentVersion);
	if (!preview.supported || preview.reason || !preview.sessionId)
		throw new Error("Compaction requires a supported, beneficial preview");
	if (preview.sourceHash !== data.expectedHash) throw new Error("Source changed since confirmation");
	await request("preflight", preview);
	try {
		await copyFile(data.file, data.backup, constants.COPYFILE_EXCL);
		await chmod(data.backup, 0o600);
		await syncFile(data.backup);
		if (process.platform !== "win32") {
			const directory = await open(dirname(data.backup), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const backup = await hashFile(data.backup);
	if (backup.hash !== data.expectedHash)
		throw new Error("Independent backup integrity check failed; original was not replaced");
	await request("backedUp", { hash: backup.hash });
	const writer = await open(data.candidate, "wx", 0o600);
	let converted: Awaited<ReturnType<typeof scan>>;
	try {
		converted = await scan(data.file, data.currentVersion, writer);
		await writer.sync();
	} finally {
		await writer.close();
	}
	if (converted.sourceHash !== data.expectedHash || converted.sourceFingerprint !== preview.sourceFingerprint)
		throw new Error("Source changed during candidate preparation");
	const candidate = await hashFile(data.candidate);
	if (candidate.hash !== converted.outputHash) throw new Error("Candidate integrity check failed");
	const source = await hashFile(data.file);
	if (source.hash !== data.expectedHash || source.fingerprint !== preview.sourceFingerprint)
		throw new Error("Source changed before publication");
	return {
		preview,
		outputHash: candidate.hash,
		outputBytes: candidate.bytes,
		sourceFingerprint: source.fingerprint,
	};
}
async function restoreCandidate(data: {
	file: string;
	expectedHash: string;
	backup: string;
	backupHash: string;
	candidate: string;
}) {
	const source = await hashFile(data.file),
		backup = await hashFile(data.backup);
	if (source.hash !== data.expectedHash)
		throw new Error("Session changed or appended after compaction; refusing to overwrite new data");
	if (backup.hash !== data.backupHash) throw new Error("Backup integrity check failed");
	await copyFile(data.backup, data.candidate, constants.COPYFILE_EXCL);
	await chmod(data.candidate, 0o600);
	await syncFile(data.candidate);
	const candidate = await hashFile(data.candidate),
		after = await hashFile(data.file);
	if (
		candidate.hash !== backup.hash ||
		after.hash !== source.hash ||
		after.fingerprint !== source.fingerprint
	)
		throw new Error("Source or restore candidate changed");
	return { outputHash: candidate.hash, outputBytes: candidate.bytes, sourceFingerprint: after.fingerprint };
}
async function main() {
	if (!parentPort) throw new Error("Invalid maintenance worker invocation");
	switch (workerData?.kind) {
		case "preview":
		case "verify": {
			const { outputHash: _outputHash, ...result } = await scan(
				workerData.file,
				workerData.currentVersion,
				undefined,
				workerData.kind === "verify",
			);
			return result;
		}
		case "hash":
			return hashFile(workerData.file);
		case "prepare":
			return prepare(workerData);
		case "restore":
			return restoreCandidate(workerData);
		default:
			throw new Error("Invalid maintenance worker invocation");
	}
}
void main().then(
	(result) => {
		parentPort?.postMessage({ type: "result", result });
		parentPort?.close();
	},
	(error) => {
		parentPort?.postMessage({
			type: "error",
			error: error instanceof Error ? error.message : "Maintenance failed",
		});
		parentPort?.close();
	},
);
