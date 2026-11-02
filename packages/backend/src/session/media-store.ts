import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ImageInput, ReferenceImage } from "@percho/shared";
import { JsonStore } from "../json-store";
import { privateDirectory } from "../storage/private-directory";

export const DISPLAY_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/svg+xml",
	"image/tiff",
	"image/avif",
	"image/heic",
	"image/heif",
]);
const DIGEST = /^[a-f0-9]{64}$/;
interface AssetMetadata {
	version: 1;
	sha256: string;
	mimeType: string;
	byteLength: number;
}
interface OwnerState {
	epoch: number;
	closed: boolean;
	identity: object;
	pending: number;
	tail: Promise<void>;
}
export interface MediaLease {
	owner: string;
	assert: () => void;
}
interface StoreOptions {
	link?: typeof link;
	copy?: typeof copyFile;
	/** 故障注入只在显式测试构造器使用，不是公开IPC。 */
	beforePublish?: () => Promise<void>;
}
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}
function sha(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function originalMime(bytes: Uint8Array, fallback: string): string {
	const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
	if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
	const text = prefix.toString("utf8");
	if (/^GIF8[79]a/.test(text)) return "image/gif";
	if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
	if (text.startsWith("BM")) return "image/bmp";
	if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return "image/svg+xml";
	return fallback;
}

/** 内容不可变、会话私有。构造/openOwner不接触磁盘，只有显式写入才建目录。 */
export class SessionMediaStore {
	private readonly root: string;
	private readonly owners = new Map<string, OwnerState>();
	private readonly verified = new Map<string, string>();
	private rootReady: Promise<void> | null = null;
	constructor(
		root: string,
		private readonly options: StoreOptions = {},
	) {
		this.root = resolve(root);
	}

	get rootDirectory(): string {
		return this.root;
	}
	openOwner(owner: string, identity: object = {}): void {
		const state = this.state(owner);
		state.epoch++;
		state.closed = false;
		state.identity = identity;
	}
	closeOwner(owner: string, expected?: object): void {
		const state = this.state(owner);
		if (expected && state.identity !== expected) return;
		state.epoch++;
		state.closed = true;
		if (!state.pending && this.owners.get(owner) === state) this.owners.delete(owner);
	}
	lease(owner: string, isCurrent: () => boolean): MediaLease {
		this.owner(owner);
		const state = this.state(owner),
			epoch = state.epoch;
		const lease = {
			owner,
			assert: () => {
				if (state.closed || state.epoch !== epoch || !isCurrent())
					throw new Error("Media owner is no longer writable");
			},
		};
		lease.assert();
		return lease;
	}

	async put(lease: MediaLease, bytes: Uint8Array, mimeType: string): Promise<ReferenceImage> {
		lease.assert();
		if (!MIME_TYPES.has(mimeType) || !bytes.byteLength || bytes.byteLength > DISPLAY_IMAGE_BYTES)
			throw new Error("Unsupported or oversized display image");
		mimeType = originalMime(bytes, mimeType);
		const digest = sha(bytes);
		return this.exclusive(lease.owner, async () => {
			lease.assert();
			const directory = await this.directory(lease.owner, true);
			lease.assert();
			const file = join(directory, `${digest}.bin`),
				metaFile = join(directory, `${digest}.json`);
			const existing = await this.statMissing(metaFile);
			if (existing) {
				const image = await this.readOriginal(lease.owner, `asset:${digest}`, digest);
				if (image.mimeType !== mimeType) throw new Error("Identical media has conflicting MIME types");
				lease.assert();
				return this.reference(lease.owner, digest, mimeType, bytes.byteLength);
			}
			// 没有metadata的孤立候选不可能已经返回成功引用；重试可替换未完成发布。
			if (await this.statMissing(file)) {
				await this.safeFile(file);
				await unlink(file);
			}
			const staged = join(directory, `.${digest}.${randomUUID()}.staging`);
			try {
				const handle = await open(
					staged,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
					0o600,
				);
				try {
					await handle.writeFile(bytes);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await this.options.beforePublish?.();
				lease.assert();
				await this.directory(lease.owner, false);
				lease.assert();
				await rename(staged, file);
				lease.assert();
				await this.metadata(metaFile).write({
					version: 1,
					sha256: digest,
					mimeType,
					byteLength: bytes.byteLength,
				});
				lease.assert();
				await this.readOriginal(lease.owner, `asset:${digest}`, digest);
				lease.assert();
				await this.syncDirectory(directory);
				return this.reference(lease.owner, digest, mimeType, bytes.byteLength);
			} finally {
				await unlink(staged).catch((error) => {
					if (code(error) !== "ENOENT") throw error;
				});
			}
		});
	}

	async read(owner: string, id: string, revision: string): Promise<ImageInput & { byteLength: number }> {
		const original = await this.readOriginal(owner, id, revision);
		return {
			mimeType: original.mimeType,
			data: original.bytes.toString("base64"),
			byteLength: original.byteLength,
		};
	}

	/** 完整性验证不构造界面/导出所需的base64副本。 */
	async verify(owner: string, id: string, revision: string): Promise<void> {
		await this.readOriginal(owner, id, revision);
	}

	private async readOriginal(
		owner: string,
		id: string,
		revision: string,
	): Promise<{ mimeType: string; bytes: Buffer; byteLength: number }> {
		const digest = this.digest(id, revision),
			directory = await this.directory(owner, false);
		const metaFile = join(directory, `${digest}.json`),
			file = join(directory, `${digest}.bin`);
		await this.safeFile(metaFile, 4096);
		const metadata = await this.metadata(metaFile).read();
		if (!metadata || metadata.sha256 !== digest) throw new Error("Media metadata is missing or invalid");
		await this.safeFile(file);
		const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size !== metadata.byteLength || info.size > DISPLAY_IMAGE_BYTES)
				throw new Error("Media size changed");
			const bytes = await handle.readFile();
			if (bytes.byteLength !== metadata.byteLength || sha(bytes) !== digest)
				throw new Error("Media checksum mismatch");
			return { mimeType: metadata.mimeType, bytes, byteLength: bytes.byteLength };
		} finally {
			await handle.close();
		}
	}

	async copyAsset(source: string, target: MediaLease, id: string, revision: string): Promise<void> {
		const digest = this.digest(id, revision);
		const original = await this.readOriginal(source, id, revision);
		target.assert();
		await this.exclusive(target.owner, async () => {
			target.assert();
			const from = await this.directory(source, false),
				to = await this.directory(target.owner, true);
			target.assert();
			const file = join(to, `${digest}.bin`),
				metaFile = join(to, `${digest}.json`);
			if (await this.statMissing(metaFile)) {
				await this.readOriginal(target.owner, id, revision);
				return;
			}
			if (await this.statMissing(file)) {
				await this.safeFile(file);
				await unlink(file);
			}
			try {
				await (this.options.link ?? link)(join(from, `${digest}.bin`), file);
			} catch (error) {
				if (!["EXDEV", "EPERM", "ENOTSUP", "EACCES", "EMLINK"].includes(code(error) ?? "")) throw error;
				await (this.options.copy ?? copyFile)(join(from, `${digest}.bin`), file, constants.COPYFILE_EXCL);
			}
			target.assert();
			await this.metadata(metaFile).write({
				version: 1,
				sha256: digest,
				mimeType: original.mimeType,
				byteLength: original.byteLength,
			});
			await this.readOriginal(target.owner, id, revision);
			target.assert();
			await this.syncDirectory(to);
		});
	}

	async deleteOwner(owner: string): Promise<void> {
		this.owner(owner);
		const state = this.state(owner);
		state.epoch++;
		state.closed = true;
		await this.exclusive(owner, async () => {
			if (!(await this.statMissing(this.root))) return;
			if (this.rootReady) await this.rootReady;
			await this.checkDirectory(this.root);
			const directory = join(this.root, this.owner(owner));
			if (!(await this.statMissing(directory))) return;
			await this.checkDirectory(directory);
			await rm(directory, { recursive: true, force: true });
			for (const key of this.verified.keys())
				if (key === directory || key.startsWith(`${directory}/`)) this.verified.delete(key);
		});
	}

	private reference(
		ownerSessionId: string,
		digest: string,
		mimeType: string,
		byteLength: number,
	): ReferenceImage {
		return {
			kind: "reference",
			ownerSessionId,
			id: `asset:${digest}`,
			revision: digest,
			mimeType,
			byteLength,
		};
	}
	private owner(owner: string): string {
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error("Invalid media owner");
		return owner;
	}
	private digest(id: string, revision: string): string {
		const digest = id.startsWith("asset:") ? id.slice(6) : "";
		if (!DIGEST.test(digest) || revision !== digest) throw new Error("Invalid asset identity");
		return digest;
	}
	private state(owner: string): OwnerState {
		let state = this.owners.get(owner);
		if (!state) {
			state = { epoch: 0, closed: false, identity: {}, pending: 0, tail: Promise.resolve() };
			this.owners.set(owner, state);
		}
		return state;
	}
	private async exclusive<T>(owner: string, work: () => Promise<T>): Promise<T> {
		const state = this.state(owner),
			previous = state.tail;
		state.pending++;
		let release = () => {};
		state.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			state.pending--;
			release();
			if (state.closed && !state.pending && this.owners.get(owner) === state) this.owners.delete(owner);
		}
	}
	private metadata(file: string) {
		return new JsonStore<AssetMetadata | undefined>({
			path: file,
			defaultValue: () => undefined,
			mode: 0o600,
			durable: true,
			parse: (raw) => {
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return undefined;
				const value = parsed as AssetMetadata;
				return value.version === 1 &&
					DIGEST.test(value.sha256) &&
					MIME_TYPES.has(value.mimeType) &&
					Number.isSafeInteger(value.byteLength) &&
					value.byteLength > 0 &&
					value.byteLength <= DISPLAY_IMAGE_BYTES
					? value
					: undefined;
			},
		});
	}
	private async directory(owner: string, create: boolean): Promise<string> {
		const directory = join(this.root, this.owner(owner));
		if ((await realpath(dirname(this.root))) !== dirname(this.root))
			throw new Error("Linked media root parent is not allowed");
		if (this.rootReady) await this.rootReady;
		if (create) {
			const ready = (async () => {
				if (!(await this.statMissing(this.root))) await this.createDirectory(this.root);
				await this.checkDirectory(this.root);
			})();
			this.rootReady = ready;
			try {
				await ready;
			} finally {
				if (this.rootReady === ready) this.rootReady = null;
			}
		} else await this.checkDirectory(this.root);
		if (create && !(await this.statMissing(directory))) await this.createDirectory(directory);
		await this.checkDirectory(directory);
		return directory;
	}
	private async createDirectory(path: string): Promise<void> {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if (code(error) !== "EEXIST") throw error;
			await this.checkDirectory(path);
			return;
		}
		await privateDirectory(path, true);
	}
	private async checkDirectory(path: string): Promise<void> {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path)
			throw new Error("Linked media directory is not allowed");
		await this.checkPrivate(path, stat);
	}
	private async safeFile(path: string, maxBytes = DISPLAY_IMAGE_BYTES): Promise<void> {
		const stat = await lstat(path);
		if (stat.size > maxBytes || stat.isSymbolicLink() || !stat.isFile())
			throw new Error("Linked media file is not allowed");
		await this.checkPrivate(path, stat);
	}
	private async checkPrivate(path: string, stat: Awaited<ReturnType<typeof lstat>>): Promise<void> {
		const identity = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mode}`;
		if (this.verified.get(path) === identity) return;
		await privateDirectory(path, false);
		this.verified.delete(path);
		this.verified.set(path, identity);
		while (this.verified.size > 512) {
			const first = this.verified.keys().next().value;
			if (first) this.verified.delete(first);
		}
	}
	private async statMissing(path: string) {
		try {
			return await lstat(path);
		} catch (error) {
			if (code(error) === "ENOENT") return null;
			throw error;
		}
	}
	private async syncDirectory(path: string): Promise<void> {
		if (process.platform === "win32") return;
		const handle = await open(path, constants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
}
