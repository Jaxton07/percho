import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, statfs, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type {
	SessionMediaTransaction as MediaTransaction,
	SessionMediaTransactionPhase as MediaTransactionPhase,
	SessionMediaPreview,
} from "@percho/shared";

export type {
	SessionMediaTransaction as MediaTransaction,
	SessionMediaTransactionPhase as MediaTransactionPhase,
} from "@percho/shared";

import { JsonStore } from "../json-store";
import { privateDirectory } from "../storage/private-directory";
import { runMaintenanceWorker } from "./maintenance-worker-client";
import type { SessionMediaStore } from "./media-store";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const SHA = /^[0-9a-f]{64}$/;
const phases = new Set<MediaTransactionPhase>([
	"queued",
	"backed-up",
	"prepared",
	"publishing",
	"published",
	"complete",
	"aborted",
	"conflict",
]);
const finished = (record: MediaTransaction) => record.phase === "complete" || record.phase === "aborted";
const fp = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
	`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
async function ensurePrivate(directory: string) {
	let created = false;
	try {
		await mkdir(directory, { mode: 0o700 });
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await privateDirectory(directory, created);
	if (created && process.platform !== "win32") {
		const parent = await open(dirname(directory), "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	}
}
async function checkRecordFile(file: string) {
	try {
		const stat = await lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error("Maintenance metadata must be an unlinked regular file");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** 只处理明确批准的单个文件。调用方提供共同操作门和驻留检查；不在启动时扫描会话正文。 */
export class SessionMediaTransactions {
	private readonly reservations = new Map<string, Promise<MediaTransaction>>();
	constructor(
		private readonly deps: {
			root: string;
			media: SessionMediaStore;
			resolveFile: (file: string) => string;
			exclusive: <T>(file: string, operation: () => Promise<T>) => Promise<T>;
			assertIdle: (file: string, owner?: string) => void;
			/** 故障测试/观测；checkpoint在持久状态落盘后调用。 */
			checkpoint?: (phase: MediaTransactionPhase, record: MediaTransaction) => Promise<void>;
			availableBytes?: (directory: string) => Promise<bigint>;
		},
	) {}
	private journalPath(requestId: string) {
		return join(this.deps.root, "records", `${digest(requestId)}.json`);
	}
	private indexPath(file: string) {
		return join(this.deps.root, "files", `${digest(file)}.json`);
	}
	private backupPath(id: string) {
		return join(this.deps.root, "backups", id, "original.backup");
	}
	private candidatePath(file: string, id: string) {
		return join(dirname(file), `.${basename(file)}.percho-${id}.pending`);
	}
	private validate(value: unknown): MediaTransaction | null {
		const item = value as MediaTransaction;
		if (
			item?.version !== 1 ||
			typeof item.requestId !== "string" ||
			typeof item.operationId !== "string" ||
			!/^[0-9a-f-]{36}$/.test(item.operationId) ||
			!["compact", "restore"].includes(item.kind) ||
			typeof item.sessionFile !== "string" ||
			resolve(item.sessionFile) !== item.sessionFile ||
			!SHA.test(item.expectedHash) ||
			!phases.has(item.phase) ||
			item.candidate !== this.candidatePath(item.sessionFile, item.operationId)
		)
			throw new Error("Invalid maintenance transaction");
		if (item.kind === "compact" && item.backup !== this.backupPath(item.operationId))
			throw new Error("Invalid independent backup path");
		if (
			item.kind === "restore" &&
			(typeof item.originalRequestId !== "string" ||
				dirname(dirname(item.backup)) !== join(this.deps.root, "backups") ||
				basename(item.backup) !== "original.backup" ||
				!/^[0-9a-f-]{36}$/.test(basename(dirname(item.backup))))
		)
			throw new Error("Invalid restore backup");
		if (
			(item.outputHash !== undefined && !SHA.test(item.outputHash)) ||
			(item.backupHash !== undefined && !SHA.test(item.backupHash))
		)
			throw new Error("Invalid maintenance digest");
		if (
			item.preview &&
			(typeof item.preview !== "object" ||
				typeof item.preview.sessionId !== "string" ||
				!/^[a-zA-Z0-9_-]{1,128}$/.test(item.preview.sessionId) ||
				!SHA.test(item.preview.sourceHash) ||
				!Number.isSafeInteger(item.preview.fileBytes) ||
				item.preview.fileBytes < 0)
		)
			throw new Error("Invalid maintenance source metadata");
		return item;
	}
	private store(requestId: string) {
		return new JsonStore<MediaTransaction | null>({
			path: this.journalPath(requestId),
			defaultValue: () => null,
			parse: (raw) => this.validate(JSON.parse(raw)),
			mode: 0o600,
			durable: true,
		});
	}
	private pointer(path: string) {
		return new JsonStore<{ requestId: string } | null>({
			path,
			defaultValue: () => null,
			mode: 0o600,
			durable: true,
			parse: (raw) => {
				const value: unknown = JSON.parse(raw);
				if (typeof value !== "object" || typeof (value as { requestId?: unknown }).requestId !== "string")
					throw new Error("Invalid maintenance index");
				return value as { requestId: string };
			},
		});
	}
	private index(file: string) {
		return this.pointer(this.indexPath(file));
	}
	async byJobId(operationId: string): Promise<MediaTransaction | null> {
		if (!/^[0-9a-f-]{36}$/.test(operationId)) return null;
		const path = join(this.deps.root, "jobs", `${operationId}.json`);
		await checkRecordFile(path);
		const pointer = await this.pointer(path).readStrict();
		if (!pointer) return null;
		const record = await this.get(pointer.requestId);
		if (!record || record.operationId !== operationId)
			throw new Error("Mismatched persistent maintenance job");
		return record;
	}
	private async directories() {
		await ensurePrivate(this.deps.root);
		for (const name of ["records", "files", "backups", "jobs"])
			await ensurePrivate(join(this.deps.root, name));
	}
	async get(requestId: string): Promise<MediaTransaction | null> {
		await checkRecordFile(this.journalPath(requestId));
		const record = await this.store(requestId).readStrict();
		if (record && record.requestId !== requestId) throw new Error("Maintenance request identity mismatch");
		return record;
	}
	async forFile(file: string): Promise<MediaTransaction | null> {
		await checkRecordFile(this.indexPath(file));
		const pointer = await this.index(file).readStrict();
		if (!pointer) return null;
		const record = await this.get(pointer.requestId);
		if (!record || record.sessionFile !== file)
			throw new Error("Missing or mismatched maintenance recovery record");
		return record;
	}
	async assertOpenAllowed(file: string): Promise<void> {
		const record = await this.forFile(file);
		// 已完成记录只读小元数据；正常打开/追加不重新hash正文。
		if (record && !finished(record))
			throw new Error("Session has unfinished maintenance; inspect or recover it before opening");
	}
	async create(input: {
		requestId: string;
		sessionFile: string;
		expectedHash: string;
		confirmed: boolean;
		restoreFrom?: string;
	}): Promise<MediaTransaction> {
		const pending = this.reservations.get(input.requestId);
		if (pending) {
			const record = await pending;
			if (
				!input.confirmed ||
				record.sessionFile !== this.deps.resolveFile(input.sessionFile) ||
				record.expectedHash !== input.expectedHash ||
				record.originalRequestId !== input.restoreFrom
			)
				throw new Error("RequestId already belongs to a different maintenance operation");
			return structuredClone(record);
		}
		const operation = this.reserve(input);
		this.reservations.set(input.requestId, operation);
		try {
			return await operation;
		} finally {
			this.reservations.delete(input.requestId);
		}
	}
	private async reserve(input: {
		requestId: string;
		sessionFile: string;
		expectedHash: string;
		confirmed: boolean;
		restoreFrom?: string;
	}): Promise<MediaTransaction> {
		if (!input.confirmed || !input.requestId || input.requestId.length > 128 || !SHA.test(input.expectedHash))
			throw new Error("Explicit confirmation, requestId and source digest are required");
		const file = this.deps.resolveFile(input.sessionFile);
		return this.deps.exclusive(file, async () => {
			await this.directories();
			const prior = await this.get(input.requestId);
			if (prior) {
				if (
					prior.sessionFile !== file ||
					prior.expectedHash !== input.expectedHash ||
					prior.originalRequestId !== input.restoreFrom
				)
					throw new Error("RequestId already belongs to a different maintenance operation");
				if (!finished(prior) && !(await this.forFile(file))) {
					this.deps.assertIdle(file);
					await this.index(file).write({ requestId: prior.requestId });
				}
				await this.pointer(join(this.deps.root, "jobs", `${prior.operationId}.json`)).write({
					requestId: prior.requestId,
				});
				return prior;
			}
			this.deps.assertIdle(file);
			const active = await this.forFile(file);
			if (active && !finished(active)) throw new Error("Session already has unfinished maintenance");
			const original = input.restoreFrom ? await this.get(input.restoreFrom) : null;
			if (
				input.restoreFrom &&
				(original?.kind !== "compact" ||
					original.phase !== "complete" ||
					original.sessionFile !== file ||
					original.outputHash !== input.expectedHash ||
					!original.backupHash)
			)
				throw new Error("Restore requires the matching completed compaction");
			const id = randomUUID(),
				now = Date.now();
			const record: MediaTransaction = {
				version: 1,
				requestId: input.requestId,
				operationId: id,
				kind: original ? "restore" : "compact",
				sessionFile: file,
				expectedHash: input.expectedHash,
				phase: "queued",
				backup: original?.backup ?? this.backupPath(id),
				candidate: this.candidatePath(file, id),
				createdAt: now,
				updatedAt: now,
				...(original
					? {
							originalRequestId: original.requestId,
							backupHash: original.backupHash,
							preview: original.preview,
						}
					: {}),
			};
			await this.store(record.requestId).update((existing) => {
				if (existing) {
					if (
						existing.sessionFile !== file ||
						existing.expectedHash !== input.expectedHash ||
						existing.originalRequestId !== input.restoreFrom
					)
						throw new Error("RequestId already belongs to a different maintenance operation");
					throw new Error("Maintenance request is already being reserved; query its existing state");
				}
				return record;
			});
			await this.pointer(join(this.deps.root, "jobs", `${record.operationId}.json`)).write({
				requestId: record.requestId,
			});
			await this.index(file).write({ requestId: record.requestId });
			await this.deps.checkpoint?.("queued", structuredClone(record));
			return record;
		});
	}
	private async save(record: MediaTransaction, phase: MediaTransactionPhase) {
		record.phase = phase;
		record.updatedAt = Date.now();
		await this.store(record.requestId).write(record);
		await this.deps.checkpoint?.(phase, structuredClone(record));
	}
	private async space(directory: string, required: number) {
		const available = this.deps.availableBytes
			? await this.deps.availableBytes(directory)
			: await statfs(directory, { bigint: true }).then((s) => s.bavail * s.bsize);
		if (available < BigInt(Math.ceil(required)) + 1024n * 1024n)
			throw new Error("Insufficient space for independent backup, candidate and original media");
	}
	async execute(
		requestId: string,
		options: {
			onWorker?: (worker: Worker) => void;
			onProgress?: (done: number, total: number) => void;
			cancelled?: () => boolean;
		} = {},
	): Promise<MediaTransaction> {
		const loaded = await this.get(requestId);
		if (!loaded) throw new Error("Maintenance transaction is unavailable");
		return this.deps.exclusive(loaded.sessionFile, async () => {
			const record = await this.get(requestId);
			if (!record) throw new Error("Maintenance transaction is unavailable");
			if (finished(record)) return record;
			this.deps.assertIdle(record.sessionFile, record.preview?.sessionId);
			const pointer = await this.forFile(record.sessionFile);
			if (pointer?.requestId !== record.requestId) throw new Error("Maintenance ownership changed");
			const run = <T>(
				data: Record<string, unknown>,
				onRequest?: (type: string, value: unknown) => Promise<unknown>,
			) =>
				runMaintenanceWorker<T>(data, {
					onWorker: options.onWorker,
					onProgress: options.onProgress,
					onRequest,
				});
			const checkCancel = () => {
				if (options.cancelled?.())
					throw new Error("Maintenance cancelled before publication; recovery record retained");
			};
			checkCancel();
			const current = await run<{ hash: string; fingerprint: string; bytes: number }>({
				kind: "hash",
				file: record.sessionFile,
			});
			if (
				["publishing", "published", "prepared", "conflict"].includes(record.phase) &&
				record.outputHash === current.hash
			) {
				const backup = await run<{ hash: string }>({ kind: "hash", file: record.backup });
				if (backup.hash !== record.backupHash) throw new Error("Recovery backup integrity check failed");
				await this.verifyReferences(record, record.sessionFile, record.outputHash, options.onWorker);
				await this.save(record, "complete");
				return record;
			}
			if (current.hash !== record.expectedHash) {
				// 发布意图之前可确认本事务从未替换来源；放弃任务但不阻挡新增历史继续打开。
				if (["queued", "backed-up", "prepared"].includes(record.phase)) await this.save(record, "aborted");
				else await this.save(record, "conflict");
				throw new Error(
					"Source changed or appended; refusing recovery over new data. Independent backup is retained",
				);
			}
			checkCancel();
			// 只删除本事务命名的非发布候选，绝不覆盖独立备份。
			try {
				const stat = await lstat(record.candidate);
				if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid maintenance candidate");
				await unlink(record.candidate);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let owner: string | undefined;
			const identity = {};
			try {
				let prepared: { outputHash: string; outputBytes: number; sourceFingerprint: string };
				if (record.kind === "restore") {
					if (!record.backupHash) throw new Error("Missing restore backup digest");
					const original = record.originalRequestId ? await this.get(record.originalRequestId) : null;
					if (
						!original ||
						original.backup !== record.backup ||
						original.backupHash !== record.backupHash ||
						original.sessionFile !== record.sessionFile
					)
						throw new Error("Restore source identity mismatch");
					await this.space(dirname(record.sessionFile), (await lstat(record.backup)).size);
					prepared = await run({
						kind: "restore",
						file: record.sessionFile,
						expectedHash: record.expectedHash,
						backup: record.backup,
						backupHash: record.backupHash,
						candidate: record.candidate,
					});
				} else {
					await ensurePrivate(dirname(record.backup));
					prepared = await run(
						{
							kind: "prepare",
							file: record.sessionFile,
							currentVersion: CURRENT_SESSION_VERSION,
							expectedHash: record.expectedHash,
							backup: record.backup,
							candidate: record.candidate,
						},
						async (type, payload) => {
							checkCancel();
							if (type === "preflight") {
								const preview = payload as SessionMediaPreview;
								if (!preview.supported || !preview.sessionId || preview.sourceHash !== record.expectedHash)
									throw new Error("Invalid maintenance preflight");
								this.deps.assertIdle(record.sessionFile, preview.sessionId);
								await this.space(this.deps.root, preview.additionalPeakBytes);
								await this.space(dirname(record.sessionFile), preview.projectedFileBytes);
								await this.space(dirname(this.deps.media.rootDirectory), preview.originalImageBytes);
								record.preview = preview;
								owner = preview.sessionId;
								this.deps.media.openOwner(owner, identity);
								return null;
							}
							if (type === "backedUp") {
								record.backupHash = record.expectedHash;
								await this.save(record, "backed-up");
								return null;
							}
							if (!owner) throw new Error("Missing media owner preflight");
							if (type === "asset") {
								const asset = payload as { bytes: Uint8Array; digest: string; mimeType: string };
								const lease = this.deps.media.lease(owner, () => !options.cancelled?.());
								const reference = await this.deps.media.put(
									lease,
									Buffer.from(asset.bytes),
									asset.mimeType === "image/jpg" ? "image/jpeg" : asset.mimeType,
								);
								if (reference.revision !== asset.digest) throw new Error("Published asset digest mismatch");
								return reference;
							}
							if (type === "verify") {
								const asset = payload as { id: string; revision: string };
								await this.deps.media.verify(owner, asset.id, asset.revision);
								return null;
							}
							throw new Error("Unknown maintenance worker request");
						},
					);
				}
				record.outputHash = prepared.outputHash;
				record.outputBytes = prepared.outputBytes;
				record.sourceFingerprint = prepared.sourceFingerprint;
				await this.save(record, "prepared");
				checkCancel();
				this.deps.assertIdle(record.sessionFile, owner ?? record.preview?.sessionId);
				const source = await lstat(record.sessionFile, { bigint: true });
				if (!source.isFile() || source.isSymbolicLink() || fp(source) !== prepared.sourceFingerprint) {
					await this.save(record, "aborted");
					throw new Error("Source changed before atomic publication; new data retained");
				}
				await this.save(record, "publishing");
				checkCancel();
				// 状态落盘/检查点也可能耗时；必须在它们之后再验证候选和来源，不能用先前的检查覆盖新追加。
				await this.verifyReferences(record, record.candidate, prepared.outputHash, options.onWorker);
				const finalSource = await run<{ hash: string; fingerprint: string }>({
					kind: "hash",
					file: record.sessionFile,
				});
				if (
					finalSource.hash !== record.expectedHash ||
					finalSource.fingerprint !== prepared.sourceFingerprint
				) {
					await this.save(record, "aborted");
					throw new Error("Source changed before atomic publication; new data retained");
				}
				checkCancel();
				const finalStat = await lstat(record.sessionFile, { bigint: true });
				if (
					!finalStat.isFile() ||
					finalStat.isSymbolicLink() ||
					fp(finalStat) !== prepared.sourceFingerprint
				) {
					await this.save(record, "aborted");
					throw new Error("Source identity changed before rename; new data retained");
				}
				checkCancel();
				await rename(record.candidate, record.sessionFile);
				if (process.platform !== "win32") {
					const directory = await open(dirname(record.sessionFile), "r");
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				}
				await this.save(record, "published");
				await this.save(record, "complete");
				return record;
			} finally {
				if (owner) this.deps.media.closeOwner(owner, identity);
			}
		});
	}
	private async verifyReferences(
		record: MediaTransaction,
		file: string,
		expectedHash: string,
		onWorker?: (worker: Worker) => void,
	) {
		const owner = record.preview?.sessionId;
		const checked = await runMaintenanceWorker<SessionMediaPreview>(
			{ kind: "verify", file, currentVersion: CURRENT_SESSION_VERSION },
			{
				onWorker,
				onRequest: async (type, payload) => {
					if (type !== "verify" || !owner) throw new Error("Invalid recovery asset verification");
					const asset = payload as { id: string; revision: string };
					await this.deps.media.verify(owner, asset.id, asset.revision);
					return null;
				},
			},
		);
		if (!checked.supported || checked.sessionId !== owner)
			throw new Error("Candidate schema or owner is not supported for recovery");
		if (checked.sourceHash !== expectedHash) throw new Error("Candidate changed after validation");
	}
	async cancelUnstarted(requestId: string): Promise<void> {
		const record = await this.get(requestId);
		if (record?.phase !== "queued") return;
		await this.deps.exclusive(record.sessionFile, async () => {
			const current = await this.get(requestId);
			if (current?.phase === "queued") await this.save(current, "aborted");
		});
	}
	async abandon(
		requestId: string,
		options: { onWorker?: (worker: Worker) => void; cancelled?: () => boolean } = {},
	): Promise<MediaTransaction> {
		const record = await this.get(requestId);
		if (!record) throw new Error("Maintenance transaction is unavailable");
		return this.deps.exclusive(record.sessionFile, async () => {
			if (finished(record)) return record;
			this.deps.assertIdle(record.sessionFile);
			const current = await runMaintenanceWorker<{ hash: string }>(
				{ kind: "hash", file: record.sessionFile },
				{ onWorker: options.onWorker },
			);
			if (options.cancelled?.()) throw new Error("Recovery cancelled; transaction retained");
			if (record.outputHash === current.hash && record.phase !== "queued") {
				const backup = await runMaintenanceWorker<{ hash: string }>(
					{ kind: "hash", file: record.backup },
					{ onWorker: options.onWorker },
				);
				if (backup.hash !== record.backupHash) throw new Error("Recovery backup integrity check failed");
				await this.verifyReferences(record, record.sessionFile, record.outputHash, options.onWorker);
				await this.save(record, "complete");
				return record;
			}
			if (current.hash !== record.expectedHash)
				throw new Error("Source conflict requires manual recovery; nothing was overwritten");
			await this.save(record, "aborted");
			return record;
		});
	}
}
