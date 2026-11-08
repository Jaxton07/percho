import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type AgentSession, type SessionIdleLease, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionArchiveInput, SessionArchiveResult } from "@percho/shared";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";
import { SUBSCRIPTION_CUSTOM_TYPE } from "../tools/channel-watch/subscriptions";
import type { CatalogArchiveProjection, SessionCatalog } from "./catalog";

const log = createLogger("session-archive");

type Phase = "prepared" | "archived-cleanup" | "archived" | "unarchived";
interface RecordEntry {
	file: string;
	id: string;
	revision: number;
	opId: string;
	archivedAt: number;
	phase: Phase;
}
interface ArchiveData {
	version: 1;
	records: RecordEntry[];
}
export interface SessionArchiveOptions {
	agentDir: string;
	catalog: () => SessionCatalog;
	getSession: (sessionId: string, sessionFile: string) => AgentSession | undefined;
	hasPending: (sessionId: string, sessionFile: string) => boolean;
	disposeSession: (sessionId: string) => Promise<void>;
	withFile: <T>(files: string[], operation: () => Promise<T>) => Promise<T>;
	resolveFile?: (file: string) => string;
}
export type SessionArchiveState = SessionArchiveResult & { phase: Phase | "none"; blocked: boolean };

function parseData(raw: string): ArchiveData {
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid archive data");
	const obj = value as Record<string, unknown>;
	if (
		Object.keys(obj).sort().join() !== "records,version" ||
		obj.version !== 1 ||
		!Array.isArray(obj.records)
	)
		throw new Error("Invalid archive data");
	const ids = new Set<string>();
	const files = new Set<string>();
	for (const item of obj.records) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid archive record");
		const r = item as Record<string, unknown>;
		if (
			Object.keys(r).sort().join() !== "archivedAt,file,id,opId,phase,revision" ||
			typeof r.file !== "string" ||
			!r.file ||
			!isAbsolute(r.file) ||
			typeof r.id !== "string" ||
			!r.id ||
			typeof r.opId !== "string" ||
			!r.opId ||
			!Number.isSafeInteger(r.revision) ||
			(r.revision as number) < 1 ||
			typeof r.archivedAt !== "number" ||
			!Number.isSafeInteger(r.archivedAt) ||
			r.archivedAt <= 0 ||
			!["prepared", "archived-cleanup", "archived", "unarchived"].includes(r.phase as string) ||
			ids.has(r.id) ||
			files.has(r.file)
		)
			throw new Error("Invalid archive record");
		ids.add(r.id);
		files.add(r.file);
	}
	return value as ArchiveData;
}

/** Read only: malformed middle lines are tolerated, but the header and final line must be complete. */
async function inspect(
	file: string,
	id: string,
): Promise<{ needsNewline: boolean; lastOp?: string; ops: Set<string>; complete: boolean }> {
	const bytes = await readFile(file);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const lines = text.split("\n");
	const needsNewline = !text.endsWith("\n");
	if (!needsNewline) lines.pop();
	if (lines.length < 2) throw new Error("Session has no persisted conversation");
	let header: any;
	let tail: any;
	try {
		header = JSON.parse(lines[0] ?? "");
		tail = JSON.parse(lines[lines.length - 1] ?? "");
	} catch {
		throw new Error("Session header or tail is invalid");
	}
	if (
		header?.type !== "session" ||
		header.id !== id ||
		!tail ||
		typeof tail !== "object" ||
		typeof tail.type !== "string"
	)
		throw new Error("Session identity or tail is invalid");
	let history = false;
	let complete = true;
	const ops = new Set<string>();
	let lastOp: string | undefined;
	for (const line of lines.slice(1)) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			complete = false;
			lastOp = undefined;
			continue;
		}
		if (entry?.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"))
			history = true;
		if (entry?.type === "custom" && entry.customType === SUBSCRIPTION_CUSTOM_TYPE) {
			const d = entry.data;
			if (typeof d?.archiveOp === "string") ops.add(d.archiveOp);
			lastOp =
				Array.isArray(d?.topics) &&
				d.topics.length === 0 &&
				d.cursors &&
				typeof d.cursors === "object" &&
				!Array.isArray(d.cursors) &&
				Object.keys(d.cursors).length === 0 &&
				typeof d.archiveOp === "string"
					? d.archiveOp
					: undefined;
		}
	}
	if (!history) throw new Error("Session has no persisted conversation");
	return { needsNewline, lastOp, ops, complete };
}

export { headerId as readSessionHeaderId };

async function headerId(file: string): Promise<string> {
	const handle = await open(file, "r");
	try {
		const bytes = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const end = bytes.indexOf(10, 0);
		if (end < 0 && bytesRead === bytes.length && (await handle.stat()).size > bytesRead)
			throw new Error("Session header is incomplete");
		const header: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end < 0 ? bytesRead : end)),
		);
		if (
			!header ||
			typeof header !== "object" ||
			(header as { type?: unknown }).type !== "session" ||
			typeof (header as { id?: unknown }).id !== "string" ||
			!(header as { id: string }).id
		)
			throw new Error("Invalid session header");
		return (header as { id: string }).id;
	} finally {
		await handle.close();
	}
}

/** Authority is independent of the disposable catalog. All mutations are serialized in this owner. */
export class SessionArchiveService {
	private readonly store: JsonStore<ArchiveData | null>;
	private readonly marker: JsonStore<{ version: 1 } | null>;
	private initialized = false;
	private uncertain = false;
	private disposed = false;
	private readonly knownStates = new Map<string, SessionArchiveState>();
	private cached?: {
		fingerprint: string;
		data: ArchiveData;
		byId: Map<string, number>;
		byFile: Map<string, number>;
	};
	private readonly drafts = new WeakMap<ArchiveData, ArchiveData>();
	private async fingerprint(): Promise<string> {
		const s = await stat(join(this.options.agentDir, "session-archive.json"), { bigint: true });
		return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
	}
	private async readAuthority(): Promise<ArchiveData> {
		const before = await this.fingerprint();
		const data = await this.store.readStrict();
		const after = await this.fingerprint();
		if (before !== after) throw new Error("Archive authority changed during read");
		if (!data) throw new Error("Archive authority missing");
		const byId = new Map<string, number>();
		const byFile = new Map<string, number>();
		data.records.forEach((r, i) => {
			byId.set(r.id, i);
			byFile.set(r.file, i);
		});
		this.cached = { fingerprint: after, data, byId, byFile };
		this.snapshot(data);
		return data;
	}
	peek(id: string, file: string): SessionArchiveState | undefined {
		const state = this.knownStates.get(id);
		return state?.sessionFile === resolve(file) ? { ...state } : undefined;
	}
	private snapshot(data: ArchiveData): void {
		this.knownStates.clear();
		for (const record of data.records)
			this.knownStates.set(record.id, this.result(record.id, record.file, record));
	}
	private readonly leases = new Map<string, SessionIdleLease>();
	private readonly retryable = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	constructor(private readonly options: SessionArchiveOptions) {
		this.store = new JsonStore({
			path: join(options.agentDir, "session-archive.json"),
			defaultValue: () => null,
			durable: true,
			parse: parseData,
		});
		this.marker = new JsonStore({
			path: join(options.agentDir, "session-archive-initialized.json"),
			defaultValue: () => null,
			durable: true,
			parse: (raw) => {
				const v: unknown = JSON.parse(raw);
				if (
					!v ||
					typeof v !== "object" ||
					Array.isArray(v) ||
					Object.keys(v).join() !== "version" ||
					(v as { version: unknown }).version !== 1
				)
					throw new Error("Invalid archive marker");
				return { version: 1 };
			},
		});
	}
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = () => {
			if (this.disposed) throw new Error("Archive service disposed");
			return fn();
		};
		const next = this.queue.then(run, run);
		this.queue = next.then(
			() => {},
			() => {},
		);
		return next;
	}
	async dispose(): Promise<void> {
		return this.serial(async () => {
			this.disposed = true;
			let failure: unknown;
			for (const [id, lease] of this.leases) {
				try {
					await this.options.disposeSession(id);
					lease.release();
					this.leases.delete(id);
				} catch (error) {
					failure ??= error;
				}
			}
			if (failure) throw failure;
		});
	}
	private file(file: string): string {
		return resolve(this.options.resolveFile?.(file) ?? file);
	}
	private async data(draft = false): Promise<ArchiveData> {
		if (!this.initialized) throw new Error("Archive service is not initialized");
		try {
			if (!(await this.marker.readStrict())) throw new Error("Archive marker missing");
			const fingerprint = await this.fingerprint();
			const data = this.cached?.fingerprint === fingerprint ? this.cached.data : await this.readAuthority();
			if (!draft) return data;
			const copy: ArchiveData = { version: 1, records: data.records.map((r) => ({ ...r })) };
			this.drafts.set(copy, data);
			return copy;
		} catch (error) {
			this.cached = undefined;
			throw error;
		}
	}
	private async save(data: ArchiveData): Promise<void> {
		// Refuse overwriting a disappeared or corrupt authority. On uncertain write require reinitialization.
		try {
			const current = await this.data();
			if (this.drafts.get(data) !== current) throw new Error("Archive authority changed before save");
			await this.store.write(data);
			const saved = await this.readAuthority();
			if (JSON.stringify(saved) !== JSON.stringify(data))
				throw new Error("Archive authority changed after save");
			this.drafts.set(data, saved);
		} catch (error) {
			this.initialized = false;
			this.uncertain = true;
			this.cached = undefined;
			throw error;
		}
	}
	private async confirmUncertain(): Promise<void> {
		if (!(await this.marker.readStrict())) throw new Error("Archive marker missing");
		this.cached = undefined;
		try {
			const current = await this.readAuthority();
			if (this.uncertain) {
				await this.store.write(current);
				await this.readAuthority();
			}
			this.uncertain = false;
			this.initialized = true;
		} catch (error) {
			this.cached = undefined;
			throw error;
		}
	}
	private find(data: ArchiveData, id: string, file: string): RecordEntry | undefined {
		const idIndex = this.cached?.byId.get(id);
		const fileIndex = this.cached?.byFile.get(file);
		const byId = idIndex === undefined ? undefined : data.records[idIndex];
		const byFile = fileIndex === undefined ? undefined : data.records[fileIndex];
		if ((byId && byId.file !== file) || (byFile && byFile.id !== id))
			throw new Error("Archive identity mismatch");
		return byId;
	}
	private projection(r: RecordEntry): CatalogArchiveProjection {
		return {
			path: r.file,
			archiveRevision: r.revision,
			archivedAt: r.phase === "unarchived" ? undefined : r.archivedAt,
			archiveCleanupPending: r.phase === "archived-cleanup" || undefined,
		};
	}
	private result(id: string, file: string, r?: RecordEntry): SessionArchiveState {
		return {
			sessionId: id,
			sessionFile: file,
			revision: r?.phase === "prepared" ? r.revision - 1 : (r?.revision ?? 0),
			archived: !!r && (r.phase === "archived" || r.phase === "archived-cleanup"),
			archivedAt: r && (r.phase === "archived" || r.phase === "archived-cleanup") ? r.archivedAt : undefined,
			cleanupPending: r?.phase === "archived-cleanup" || undefined,
			phase: r?.phase ?? "none",
			blocked: !!r && r.phase !== "unarchived",
		};
	}
	async init(): Promise<void> {
		return this.serial(async () => {
			this.initialized = false;
			const marker = await this.marker.readStrict();
			const data = await this.store.readStrict();
			if (!marker && data) throw new Error("Archive marker missing");
			if (marker && !data) throw new Error("Archive authority missing");
			if (!marker && !data) {
				await this.marker.write({ version: 1 });
				await this.store.write({ version: 1, records: [] });
			}
			await this.confirmUncertain();
			const current = await this.data(true);
			for (const r of current.records) {
				if (r.phase !== "prepared") continue;
				await this.options.withFile([r.file], async () => {
					let matches = false;
					try {
						matches = (await inspect(r.file, r.id)).lastOp === r.opId;
					} catch {
						/* retain blocked intent */
					}
					if (!matches) return;
					const handle = await open(r.file, "r+");
					try {
						await handle.sync();
					} finally {
						await handle.close();
					}
					r.phase = "archived-cleanup";
					await this.save(current);
					// A stale disposable index must never prevent recovery of the authoritative state.
					try {
						await this.options.catalog().setArchive(this.projection(r));
					} catch (error) {
						log.warn("Archive catalog projection failed", error);
					}
				});
			}
		});
	}
	async projections(): Promise<CatalogArchiveProjection[]> {
		return this.serial(async () =>
			(await this.data()).records.filter((r) => r.phase !== "prepared").map((r) => this.projection(r)),
		);
	}
	async state(id: string, sessionFile: string): Promise<SessionArchiveState> {
		return this.serial(async () => {
			const file = this.file(sessionFile);
			return this.result(id, file, this.find(await this.data(), id, file));
		});
	}
	async assertOpen(sessionFile: string, expectedId?: string): Promise<void> {
		return this.serial(async () => {
			const file = this.file(sessionFile);
			const data = await this.data();
			let id: string;
			try {
				id = await headerId(file);
			} catch (error) {
				if (!expectedId || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				id = expectedId;
			}
			if (expectedId && id !== expectedId) throw new Error("Archive identity mismatch");
			const r = this.find(data, id, file);
			if ((r && r.phase !== "unarchived") || this.leases.has(id))
				throw new Error("Session is archived or archive state is unresolved");
		});
	}
	private async verify(id: string, file: string): Promise<void> {
		const [v] = await this.options.catalog().verify([{ sessionId: id, sessionFile: file }]);
		if (
			!v ||
			!["present", "archived"].includes(v.status) ||
			v.meta?.sessionId !== id ||
			!v.meta.sessionFile ||
			this.file(v.meta.sessionFile) !== file
		)
			throw new Error("Session catalog identity is unavailable or ambiguous");
	}
	private async cleanup(data: ArchiveData, r: RecordEntry): Promise<boolean> {
		if (r.phase !== "archived-cleanup") return true;
		try {
			await this.options.disposeSession(r.id);
		} catch {
			return false;
		}
		this.leases.get(r.id)?.release();
		this.leases.delete(r.id);
		r.phase = "archived";
		await this.save(data);
		try {
			await this.options.catalog().setArchive(this.projection(r));
		} catch (error) {
			log.warn("Archive catalog projection failed", error);
		}
		return true;
	}
	async retryCleanup(sessionId: string, sessionFile: string): Promise<void> {
		return this.serial(async () => {
			const file = this.file(sessionFile);
			await this.options.withFile([file], async () => {
				const d = await this.data(true);
				const r = this.find(d, sessionId, file);
				if (r?.phase !== "archived-cleanup") throw new Error("No pending archive cleanup");
				if (!(await this.cleanup(d, r))) throw new Error("Archive cleanup failed; retry is required");
			});
		});
	}
	async archive(input: SessionArchiveInput): Promise<SessionArchiveResult> {
		return this.serial(async () => {
			const file = this.file(input.sessionFile);
			return this.options.withFile([file], async () => {
				if (!this.initialized) await this.confirmUncertain();
				const data = await this.data(true);
				let r = this.find(data, input.sessionId, file);
				if (r?.phase === "prepared" && !this.retryable.has(r.opId))
					throw new Error("Archive operation is unresolved");
				if (r && (r.phase === "archived" || r.phase === "archived-cleanup")) {
					try {
						await this.options.catalog().setArchive(this.projection(r));
					} catch (error) {
						log.warn("Archive catalog projection failed", error);
					}
					if (r.phase === "archived-cleanup") await this.cleanup(data, r);
					return this.result(input.sessionId, file, r);
				}
				if ((r?.phase === "prepared" ? r.revision - 1 : (r?.revision ?? 0)) !== input.expectedRevision)
					throw new Error("Archive revision conflict");
				await this.verify(input.sessionId, file);
				if (this.options.hasPending(input.sessionId, file)) throw new Error("Session is busy");
				const session = this.options.getSession(input.sessionId, file);
				const loadedFile = session?.sessionManager.getSessionFile();
				if (
					session &&
					(!loadedFile ||
						this.file(loadedFile) !== file ||
						session.sessionManager.getSessionId() !== input.sessionId)
				)
					throw new Error("Loaded session identity mismatch");
				const lease = this.leases.get(input.sessionId) ?? session?.tryAcquireIdleLease();
				if (session && !lease) throw new Error("Session is busy");
				let retain = this.leases.has(input.sessionId) || r?.phase === "prepared";
				try {
					if (this.options.hasPending(input.sessionId, file)) throw new Error("Session is busy");
					const checked = await inspect(file, input.sessionId);
					if (
						r?.phase === "prepared" &&
						(!checked.complete || (checked.ops.has(r.opId) && checked.lastOp !== r.opId))
					)
						throw new Error("Archive operation is unresolved");
					if (r?.phase === "prepared" && checked.lastOp === r.opId) {
						const h = await open(file, "r+");
						try {
							await h.sync();
						} finally {
							await h.close();
						}
						r.phase = "archived-cleanup";
						await this.save(data);
						this.retryable.delete(r.opId);
						try {
							await this.options.catalog().setArchive(this.projection(r));
						} catch (error) {
							log.warn("Archive catalog projection failed", error);
						}
						await this.cleanup(data, r);
						return this.result(input.sessionId, file, r);
					}
					if (r?.phase !== "prepared") {
						r = {
							id: input.sessionId,
							file,
							revision: (r?.revision ?? 0) + 1,
							opId: randomUUID(),
							archivedAt: Date.now(),
							phase: "prepared",
						};
						data.records = data.records.filter((item) => item.id !== input.sessionId);
						data.records.push(r);
						// A failed durable write may already have renamed the record.
						retain = true;
						if (lease) this.leases.set(input.sessionId, lease);
						this.retryable.add(r.opId);
						await this.save(data);
					}
					if (checked.needsNewline) {
						const h = await open(file, constants.O_WRONLY | constants.O_APPEND);
						try {
							await h.writeFile("\n");
							await h.sync();
						} finally {
							await h.close();
						}
					}
					const payload = { topics: [], cursors: {}, archiveOp: r.opId };
					if (lease) lease.appendCustomEntry(SUBSCRIPTION_CUSTOM_TYPE, payload);
					else
						SessionManager.open(file).appendCustomEntry(SUBSCRIPTION_CUSTOM_TYPE, payload, {
							requireExisting: true,
						});
					const h = await open(file, "r+");
					try {
						await h.sync();
					} finally {
						await h.close();
					}
					if ((await inspect(file, input.sessionId)).lastOp !== r.opId)
						throw new Error("Archive unsubscribe could not be verified");
					r.phase = "archived-cleanup";
					await this.save(data);
					this.retryable.delete(r.opId);
					try {
						await this.options.catalog().setArchive(this.projection(r));
					} catch (error) {
						log.warn("Archive catalog projection failed", error);
					}
					await this.cleanup(data, r);
					return this.result(input.sessionId, file, r);
				} finally {
					if (!retain) lease?.release();
				}
			});
		});
	}
	async unarchive(input: SessionArchiveInput): Promise<SessionArchiveResult> {
		return this.serial(async () => {
			const file = this.file(input.sessionFile);
			return this.options.withFile([file], async () => {
				const data = await this.data(true);
				const r = this.find(data, input.sessionId, file);
				if (r?.phase === "prepared") throw new Error("Archive operation is unresolved");
				if (!r || r.phase === "unarchived") {
					if (this.leases.has(input.sessionId)) throw new Error("Archive operation is unresolved");
					return this.result(input.sessionId, file, r);
				}
				if (r.revision !== input.expectedRevision) throw new Error("Archive revision conflict");
				if (r.phase === "archived-cleanup" && !(await this.cleanup(data, r)))
					throw new Error("Archive cleanup failed; retry is required");
				await this.verify(input.sessionId, file);
				r.revision++;
				r.opId = randomUUID();
				r.phase = "unarchived";
				await this.save(data);
				try {
					await this.options.catalog().setArchive(this.projection(r));
				} catch (error) {
					log.warn("Archive catalog projection failed", error);
				}
				return this.result(input.sessionId, file, r);
			});
		});
	}
	async removeRecord(sessionId: string, sessionFile: string): Promise<void> {
		return this.serial(async () => {
			const file = this.file(sessionFile);
			await this.options.withFile([file], async () => {
				const data = await this.data(true);
				const r = this.find(data, sessionId, file);
				if (!r) {
					try {
						await this.options.catalog().setArchive({ path: file, archiveRevision: 0 });
					} catch (error) {
						log.warn("Archive catalog projection failed", error);
					}
					return;
				}
				if (r.phase === "prepared" || r.phase === "archived-cleanup")
					throw new Error("Archive operation is unresolved");
				data.records = data.records.filter((item) => item !== r);
				await this.save(data);
				try {
					await this.options.catalog().setArchive({ path: file, archiveRevision: 0 });
				} catch (error) {
					log.warn("Archive catalog projection failed", error);
				}
			});
		});
	}
}
