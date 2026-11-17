import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import {
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
	type DisplayImage,
	displayImagesFromDetails,
	type ImageInput,
	isImageInput,
	isReferenceImage,
	type ReferenceImage,
	type SessionMessage,
} from "@percho/shared";
import { displayDetails } from "./media-entries";
import { blockImages, toBranchSessionMessages } from "./messages";
import { measureSessionSwitch } from "./switch-diagnostics";

type Fingerprint = { identity: string; stamp: string };
type Metadata = { owner: string; version: string; fingerprint: Fingerprint };
export interface SourceSnapshot {
	owner: string;
	version: string;
	file?: string;
	fingerprint: Fingerprint | null;
	branch: readonly SessionEntry[];
	entries: readonly SessionEntry[];
	header?: SessionHeader;
	byId: Map<string, SessionEntry>;
	entryCount: number;
	lastEntryId?: string;
	readOnly: boolean;
	shareable: boolean;
	pending: Map<string, { kind: "user" | "show"; images: DisplayImage[] }>;
	pendingKeys: WeakMap<DisplayImage[], string>;
}

function fingerprint(file: string): Fingerprint {
	const info = statSync(file, { bigint: true });
	if (!info.isFile()) throw new Error("Session source is not a regular file");
	return { identity: `${info.dev}:${info.ino}`, stamp: `${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
}
function same(a: Fingerprint | null | undefined, b: Fingerprint | null | undefined): boolean {
	return a?.identity === b?.identity && a?.stamp === b?.stamp;
}

/** 只有这个检视实例持有原始entry。跨GC的LRU严格只含路径、文件指纹及版本。 */
function appendedJson(entries: readonly SessionEntry[]): string {
	return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

function persistedAppendMatches(file: string, current: Fingerprint, json: string): boolean {
	// 分块核验本次新增字节，不扫描既有历史，也不因大图片只检查末尾而漏掉前部损坏。
	const size = Number(current.stamp.split(":")[0]);
	const bytes = Buffer.byteLength(json);
	if (!json.length || !Number.isSafeInteger(size) || size < bytes) return false;
	const fd = openSync(file, "r");
	try {
		let position = size - bytes;
		for (let start = 0; start < json.length; ) {
			let end = Math.min(start + 16 * 1024, json.length);
			const last = json.charCodeAt(end - 1);
			if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
			const expected = Buffer.from(json.slice(start, end));
			const actual = Buffer.allocUnsafe(expected.byteLength);
			if (
				readSync(fd, actual, 0, actual.byteLength, position) !== actual.byteLength ||
				!actual.equals(expected)
			)
				return false;
			position += expected.byteLength;
			start = end;
		}
		return true;
	} finally {
		closeSync(fd);
	}
}

export class SessionSourceSnapshots {
	private readonly views = new Map<object, SourceSnapshot>();
	private readonly disposed = new WeakSet<object>();
	private readonly metadata = new Map<string, Metadata>();
	private readonly loaded = new WeakMap<object, { fingerprint?: Fingerprint; trusted: boolean }>();

	fileVersion(file: string): Fingerprint {
		return fingerprint(realpathSync(file));
	}
	noteLoaded(manager: object, file: string, before: Fingerprint): void {
		const after = this.fileVersion(file);
		this.loaded.set(manager, { fingerprint: after, trusted: same(before, after) });
	}
	private parses = 0;
	private peakViews = 0;

	notePersisted(
		manager: object,
		file: string | undefined,
		appended?: SessionEntry | readonly SessionEntry[],
	): void {
		if (!file) return;
		const previous = this.loaded.get(manager);
		try {
			file = realpathSync(file);
			const next = fingerprint(file);
			if (!previous) this.loaded.set(manager, { fingerprint: next, trusted: true });
			else if (appended && previous.trusted && previous.fingerprint && !same(previous.fingerprint, next)) {
				const baseline = previous.fingerprint;
				const json = appendedJson("type" in appended ? [appended] : appended);
				if (
					baseline.identity === next.identity &&
					Number(next.stamp.split(":")[0]) - Number(baseline.stamp.split(":")[0]) ===
						Buffer.byteLength(json) &&
					persistedAppendMatches(file, next, json) &&
					same(next, fingerprint(file))
				) {
					this.loaded.set(manager, { fingerprint: next, trusted: true });
					const cached = this.metadata.get(file);
					if (cached && same(cached.fingerprint, baseline))
						this.remember(file, { ...cached, fingerprint: next });
				} else this.loaded.set(manager, { ...previous, trusted: false });
			} else if (previous.fingerprint?.identity !== next.identity)
				this.loaded.set(manager, { ...previous, trusted: false });
		} catch {
			if (previous) this.loaded.set(manager, { ...previous, trusted: false });
		}
	}

	private readOnlyFile(file: string): { file: string; stamp: Fingerprint; entries: FileEntry[] } {
		const end = measureSessionSwitch("sourceParse");
		try {
			const stamp = fingerprint(file),
				entries = parseSessionEntries(readFileSync(file, "utf8"));
			this.parses++;
			migrateSessionEntries(entries); // 仅内存规范化；禁止SessionManager.open的隐式落盘。
			if (!same(stamp, fingerprint(file))) throw new Error("Source changed while parsing");
			return { file, stamp, entries };
		} finally {
			end();
		}
	}

	openReadOnly(owner: object, file: string): SourceSnapshot {
		file = realpathSync(file);
		const prepared = this.readOnlyFile(file),
			header = prepared.entries[0];
		if (header?.type !== "session" || typeof header.id !== "string")
			throw new Error("Missing session header");
		return this.capture(
			owner,
			{ sessionId: header.id, file, readOnly: true, branch: () => [], entries: () => [] },
			prepared,
		);
	}

	capture(
		owner: object,
		input: {
			sessionId: string;
			file?: string;
			branch: () => readonly SessionEntry[];
			entries: () => readonly SessionEntry[];
			readOnly?: boolean;
			loadedFrom?: object;
			header?: () => SessionHeader | null | undefined;
		},
		prepared?: { file: string; stamp: Fingerprint; entries: FileEntry[] },
	): SourceSnapshot {
		if (this.disposed.has(owner)) throw new Error("Session source has been disposed");
		const file = input.file ? realpathSync(input.file) : undefined;
		const current = file ? fingerprint(file) : null;
		const previous = this.views.get(owner);
		const reusable =
			previous &&
			previous.owner === input.sessionId &&
			previous.file === file &&
			previous.readOnly === !!input.readOnly &&
			same(previous.fingerprint, current);
		let branch: readonly SessionEntry[], all: readonly SessionEntry[];
		let header: SessionHeader | undefined;
		if (input.readOnly && reusable) return previous;
		if (input.readOnly && file) {
			const loadedFile = prepared ?? this.readOnlyFile(file);
			if (loadedFile.file !== file || !same(loadedFile.stamp, current))
				throw new Error("Source changed while parsing");
			const parsed = loadedFile.entries;
			header = parsed[0]?.type === "session" ? parsed[0] : undefined;
			if (header?.type !== "session" || header.id !== input.sessionId)
				throw new Error("Session source identity changed");
			const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
			all = entries;
			const index = new Map(entries.map((entry) => [entry.id, entry]));
			const reverse: SessionEntry[] = [];
			const seen = new Set<string>();
			let leaf = entries.at(-1);
			while (leaf) {
				if (seen.has(leaf.id)) throw new Error("Cyclic session source");
				seen.add(leaf.id);
				reverse.push(leaf);
				leaf = leaf.parentId ? index.get(leaf.parentId) : undefined;
			}
			branch = reverse.reverse();
		} else {
			branch = input.branch();
			all = input.entries();
			header = input.header?.() ?? undefined;
		}
		const loaded = input.loadedFrom ? this.loaded.get(input.loadedFrom) : undefined;
		// SDK内存仍可能是外部改写前的图：可供当前实例阅读，但不能认证给GC后的新SDK。
		const shareable =
			!!input.readOnly ||
			(previous
				? previous.shareable && previous.file === file && same(previous.fingerprint, current)
				: !loaded || (loaded.trusted && same(loaded.fingerprint, current)));
		if (!shareable && file) {
			this.metadata.delete(file);
			if (input.loadedFrom)
				this.loaded.set(input.loadedFrom, { fingerprint: current ?? undefined, trusted: false });
		}
		const cached = file && shareable ? this.metadata.get(file) : undefined;
		const version = reusable
			? previous.version
			: cached?.owner === input.sessionId && same(cached.fingerprint, current)
				? cached.version
				: randomUUID();
		const view: SourceSnapshot = {
			owner: input.sessionId,
			version,
			file,
			fingerprint: current,
			branch,
			entries: all,
			header,
			byId: new Map(all.map((entry) => [entry.id, entry])),
			entryCount: all.length,
			lastEntryId: all.at(-1)?.id,
			readOnly: !!input.readOnly,
			shareable,
			pending: reusable ? previous.pending : new Map(),
			pendingKeys: reusable ? previous.pendingKeys : new WeakMap(),
		};
		this.views.set(owner, view);
		this.peakViews = Math.max(this.peakViews, this.views.size);
		if (file && current && shareable)
			this.remember(file, { owner: input.sessionId, version, fingerprint: current });
		return view;
	}

	/** SDK entry_appended在实际持久化后发出。仅可信追加保留旧图版本，不把外部换文件当追加。 */
	noteAppend(
		owner: object,
		appended: SessionEntry | undefined,
		entryCount: number,
		file?: string,
		manager?: object,
	): void {
		const view = this.views.get(owner);
		if (!view || view.readOnly || this.disposed.has(owner)) return;
		const distrust = () => {
			view.shareable = false;
			if (view.file) this.metadata.delete(view.file);
			if (manager) this.loaded.set(manager, { fingerprint: view.fingerprint ?? undefined, trusted: false });
		};
		try {
			const creating = !view.file;
			if (!view.file && file && appended?.id && entryCount > view.entryCount) {
				view.file = realpathSync(file);
				view.fingerprint = fingerprint(view.file);
			}
			if (!view.file || !appended?.id || entryCount <= view.entryCount) return;
			const current = fingerprint(view.file);
			if (
				current.identity !== view.fingerprint?.identity ||
				(!creating &&
					Number(current.stamp.split(":")[0]) - Number(view.fingerprint.stamp.split(":")[0]) !==
						Buffer.byteLength(`${JSON.stringify(appended)}\n`)) ||
				!persistedAppendMatches(view.file, current, appendedJson([appended])) ||
				!same(current, fingerprint(view.file))
			) {
				distrust();
				return;
			}
			const loaded = manager ? this.loaded.get(manager) : undefined;
			if (manager && loaded?.trusted && same(loaded.fingerprint, view.fingerprint))
				this.loaded.set(manager, { fingerprint: current, trusted: true });
			view.fingerprint = current;
			view.entryCount = entryCount;
			view.lastEntryId = appended.id;
			if (view.shareable)
				this.remember(view.file, { owner: view.owner, version: view.version, fingerprint: current });
		} catch {
			distrust();
		} // 不让派生身份处理打断SDK输出，但绝不认证未完成的保存。
	}

	private references(
		view: SourceSnapshot,
		entryId: string,
		kind: "user" | "show",
		images: DisplayImage[],
	): ReferenceImage[] {
		return images.map((image, index) =>
			isReferenceImage(image) && image.id.startsWith("asset:")
				? { ...image, ownerSessionId: view.owner }
				: {
						kind: "reference",
						ownerSessionId: view.owner,
						id: `entry:${entryId}:${kind}:${index}`,
						revision: view.version,
						mimeType: image.mimeType,
					},
		);
	}

	project(
		view: SourceSnapshot,
		includeUsers = true,
		branch: readonly SessionEntry[] = view.branch,
	): SessionMessage[] {
		return toBranchSessionMessages(branch, view.owner).map((message) => {
			if (message.role !== "image" && !(includeUsers && message.role === "user")) return message;
			if (!message.entryId) throw new Error("Image history has no entry identity");
			const entryId = message.entryId;
			return {
				...message,
				images: this.references(view, entryId, message.role === "user" ? "user" : "show", message.images),
			};
		});
	}

	/** 未持久化的真实SDK活动消息：以源view签发不落盘的临时定位符，不猜时间戳/entry。 */
	projectTransient(
		view: SourceSnapshot,
		sourceId: string,
		kind: "user" | "show",
		images: DisplayImage[],
		sourceMessage?: object,
	): DisplayImage[] {
		if (!images.length) return images;
		const entry =
			kind === "show"
				? view.branch.findLast(
						(candidate) =>
							!!sourceMessage &&
							candidate.type === "message" &&
							candidate.message.role === "toolResult" &&
							candidate.message === sourceMessage,
					)
				: view.byId.get(sourceId);
		if (entry?.type === "message") {
			const exact =
				kind === "show"
					? displayImagesFromDetails(displayDetails(entry, view.byId))?.images
					: entry.message.role === "user"
						? blockImages(entry.message.content as Parameters<typeof blockImages>[0])
						: undefined;
			if (exact) return this.references(view, entry.id, kind, exact);
		}
		let key = view.pendingKeys.get(images);
		if (!key) {
			key = `pending:${encodeURIComponent(`${kind}:${sourceId}`)}:${randomUUID()}`;
			view.pendingKeys.set(images, key);
			view.pending.set(key, { kind, images });
		}
		return images.map((image, index) =>
			isImageInput(image)
				? {
						kind: "reference",
						ownerSessionId: view.owner,
						id: `${key}:${index}`,
						revision: view.version,
						mimeType: image.mimeType,
					}
				: { ...image, ownerSessionId: view.owner },
		);
	}

	resolve(
		owner: object,
		sessionId: string,
		imageId: string,
		revision: string,
	): ImageInput & { byteLength: number } {
		const view = this.views.get(owner);
		if (!view || this.disposed.has(owner) || view.owner !== sessionId || view.version !== revision)
			throw new Error("Stale or unloaded image source");
		if (view.file && !same(view.fingerprint, fingerprint(view.file)))
			throw new Error("Image source changed; reload history");
		const pendingMatch = /^(pending:[^:]+:[a-z0-9-]+):(0|[1-9]\d*)$/.exec(imageId);
		if (pendingMatch) {
			const pending = view.pending.get(pendingMatch[1] ?? "");
			const image = pending?.images[Number(pendingMatch[2])];
			if (!pending || !isImageInput(image)) throw new Error("Pending image is unavailable");
			const byteLength = Buffer.byteLength(image.data, "base64");
			if (pending.kind === "show" && byteLength > 10 * 1024 * 1024)
				throw new Error("Display image exceeds 10MiB");
			return { data: image.data, mimeType: image.mimeType, byteLength };
		}
		const match = /^entry:([^:]+):(show|user):(0|[1-9]\d*)$/.exec(imageId);
		if (!match) throw new Error("Invalid image reference");
		const entry = view.byId.get(match[1] ?? "");
		if (entry?.type !== "message") throw new Error("Image entry is unavailable");
		const message = entry.message as {
			role?: string;
			content?: Parameters<typeof blockImages>[0];
			details?: unknown;
			toolName?: string;
			toolCallId?: string;
		};
		let images: import("@percho/shared").DisplayImage[];
		if (match[2] === "user" && message.role === "user") images = blockImages(message.content);
		else if (match[2] === "show" && message.role === "toolResult") {
			const details = displayDetails(entry, view.byId);
			if (!details) throw new Error("Entry is not a display tool result");
			images = displayImagesFromDetails(details)?.images ?? [];
		} else throw new Error("Image reference kind does not match entry");
		const image = images[Number(match[3])];
		if (!image || !isImageInput(image)) throw new Error("Image index is unavailable");
		const byteLength = Buffer.byteLength(image.data, "base64");
		if (match[2] === "show" && byteLength > 10 * 1024 * 1024) throw new Error("Display image exceeds 10MiB");
		return { data: image.data, mimeType: image.mimeType, byteLength };
	}

	has(owner: object): boolean {
		return this.views.has(owner);
	}
	release(owner: object): void {
		this.disposed.add(owner);
		this.views.delete(owner);
	}
	invalidateFile(file: string): void {
		this.metadata.delete(file);
	}
	invalidateOwner(sessionId: string): void {
		for (const [file, value] of this.metadata) if (value.owner === sessionId) this.metadata.delete(file);
		for (const [owner, view] of this.views) if (view.owner === sessionId) this.release(owner);
	}
	dispose(): void {
		for (const owner of this.views.keys()) this.release(owner);
		this.metadata.clear();
	}
	stats() {
		return {
			views: this.views.size,
			metadata: this.metadata.size,
			parses: this.parses,
			peakViews: this.peakViews,
		};
	}
	private remember(file: string, value: Metadata): void {
		this.metadata.delete(file);
		this.metadata.set(file, value);
		while (this.metadata.size > 128) {
			const oldest = this.metadata.keys().next().value;
			if (oldest !== undefined) this.metadata.delete(oldest);
		}
	}
}
