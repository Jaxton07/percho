import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { SessionMediaJob, SessionMediaPreview, SessionMediaTransaction } from "@percho/shared";

const QUEUE_LIMIT = 4;
const HISTORY_LIMIT = 32;
const terminal = (job: SessionMediaJob) => ["cancelled", "completed", "failed"].includes(job.status);

/** 单worker+有界队列；主线程不解析正文，不持有原图。预览任务不持久写入。 */
export class SessionMediaMaintenanceJobs {
	private readonly jobs = new Map<string, SessionMediaJob>();
	private readonly queue: string[] = [];
	private active?: { id: string; worker?: Worker };
	private stopped = false;
	private readonly operations = new Map<
		string,
		(options: {
			onWorker: (worker: Worker) => void;
			onProgress: (done: number, total: number) => void;
			cancelled: () => boolean;
		}) => Promise<SessionMediaTransaction>
	>();
	assertCapacity(): void {
		if (this.stopped) throw new Error("Maintenance service is stopping");
		if (this.queue.length + (this.active ? 1 : 0) >= QUEUE_LIMIT)
			throw new Error("Maintenance queue is full");
	}
	enqueue(
		record: SessionMediaTransaction,
		execute: (options: {
			onWorker: (worker: Worker) => void;
			onProgress: (done: number, total: number) => void;
			cancelled: () => boolean;
		}) => Promise<SessionMediaTransaction>,
	): SessionMediaJob {
		const existing = this.jobs.get(record.operationId);
		if (existing && (!terminal(existing) || this.active?.id === record.operationId))
			return structuredClone(existing);
		const done = record.phase === "complete" || record.phase === "aborted";
		if (!done) this.assertCapacity();
		const job: SessionMediaJob = {
			jobId: record.operationId,
			requestId: record.requestId,
			kind: record.kind,
			sessionFile: record.sessionFile,
			transaction: record,
			status: done ? (record.phase === "complete" ? "completed" : "cancelled") : "queued",
			createdAt: record.createdAt,
			updatedAt: Date.now(),
			processedBytes: 0,
			totalBytes: record.preview?.fileBytes ?? 0,
		};
		this.jobs.set(job.jobId, job);
		if (!done) {
			this.operations.set(job.jobId, execute);
			this.queue.push(job.jobId);
		}
		this.trim();
		this.pump();
		return structuredClone(job);
	}
	private work?: Promise<void>;
	constructor(
		private readonly deps: {
			resolveFile: (file: string) => string;
			read: <T>(file: string, operation: () => Promise<T>) => Promise<T>;
			workerPath?: string;
		},
	) {}

	startPreview(sessionFile: string): SessionMediaJob {
		if (this.stopped) throw new Error("Maintenance service is stopping");
		const file = this.deps.resolveFile(sessionFile);
		for (const job of this.jobs.values())
			if (job.kind === "preview" && job.sessionFile === file && !terminal(job)) return structuredClone(job);
		if (this.queue.length + (this.active ? 1 : 0) >= QUEUE_LIMIT)
			throw new Error("Maintenance queue is full");
		const now = Date.now(),
			job: SessionMediaJob = {
				jobId: randomUUID(),
				kind: "preview",
				sessionFile: file,
				status: "queued",
				processedBytes: 0,
				totalBytes: 0,
				createdAt: now,
				updatedAt: now,
			};
		this.jobs.set(job.jobId, job);
		this.queue.push(job.jobId);
		this.trim();
		this.pump();
		return structuredClone(job);
	}
	find(jobId: string): SessionMediaJob | undefined {
		const job = this.jobs.get(jobId);
		return job ? structuredClone(job) : undefined;
	}
	get(jobId: string): SessionMediaJob {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error("Maintenance job is unavailable");
		return structuredClone(job);
	}
	cancel(jobId: string): SessionMediaJob {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error("Maintenance job is unavailable");
		if (terminal(job)) return structuredClone(job);
		job.status = this.active?.id === jobId ? "cancelling" : "cancelled";
		job.updatedAt = Date.now();
		if (this.active?.id === jobId) void this.active.worker?.terminate();
		else {
			const index = this.queue.indexOf(jobId);
			if (index !== -1) this.queue.splice(index, 1);
			this.operations.delete(jobId);
		}
		return structuredClone(job);
	}
	stats() {
		return {
			jobs: this.jobs.size,
			queued: this.queue.filter((id) => this.jobs.get(id)?.status === "queued").length,
			workers: this.active?.worker ? 1 : 0,
		};
	}
	async dispose(): Promise<void> {
		this.stopped = true;
		for (const job of this.jobs.values()) if (!terminal(job)) this.cancel(job.jobId);
		await this.work;
	}
	private trim(): void {
		for (const [id, job] of this.jobs) {
			if (this.jobs.size <= HISTORY_LIMIT) break;
			if (terminal(job)) this.jobs.delete(id);
		}
	}
	private pump(): void {
		if (this.active || this.stopped) return;
		let job: SessionMediaJob | undefined;
		while (this.queue.length && !job) {
			const id = this.queue.shift();
			const next = id ? this.jobs.get(id) : undefined;
			if (next?.status === "queued") job = next;
		}
		if (!job) return;
		const current = job;
		current.status = "running";
		current.updatedAt = Date.now();
		this.active = { id: current.jobId };
		this.work = Promise.resolve()
			.then(async () => {
				if (current.kind === "preview") {
					await this.deps.read(current.sessionFile, () => this.scan(current));
					if (current.status !== "cancelling") current.status = "completed";
					return;
				}
				const execute = this.operations.get(current.jobId);
				if (!execute) throw new Error("Maintenance executor unavailable");
				const result = await execute({
					onWorker: (worker) => {
						if (this.active?.id === current.jobId) this.active.worker = worker;
					},
					onProgress: (done, total) => {
						current.processedBytes = done;
						current.totalBytes = total;
						current.updatedAt = Date.now();
					},
					cancelled: () => current.status === "cancelling",
				});
				current.transaction = result;
				current.status = result.phase === "complete" ? "completed" : "cancelled";
			})
			.catch((error) => {
				if (current.status !== "cancelling") {
					current.status = "failed";
					current.error = error instanceof Error ? error.message : "Maintenance failed";
				}
			})
			.finally(() => {
				if (current.status === "cancelling") current.status = "cancelled";
				current.updatedAt = Date.now();
				this.operations.delete(current.jobId);
				this.active = undefined;
				this.trim();
				this.pump();
			});
	}
	private scan(job: SessionMediaJob): Promise<void> {
		if (job.status === "cancelling") return Promise.resolve();
		const slot = this.active;
		if (!slot || slot.id !== job.jobId)
			return Promise.reject(new Error("Maintenance worker ownership changed"));
		const directory = dirname(fileURLToPath(import.meta.url)),
			source = join(directory, "media-maintenance-worker.ts");
		const location =
			this.deps.workerPath ?? (existsSync(source) ? source : join(directory, "session-media-worker.mjs"));
		return new Promise((resolve, reject) => {
			const worker = new Worker(location, {
				workerData: { kind: "preview", file: job.sessionFile, currentVersion: CURRENT_SESSION_VERSION },
				execArgv: location.endsWith(".ts") ? ["--experimental-strip-types"] : [],
				resourceLimits: { maxOldGenerationSizeMb: 384 },
			});
			slot.worker = worker;
			let outcome = false,
				workerError: Error | undefined;
			worker.on(
				"message",
				(message: {
					type: string;
					result?: SessionMediaPreview;
					processedBytes?: number;
					totalBytes?: number;
					error?: string;
				}) => {
					if (job.status === "cancelling") return;
					job.updatedAt = Date.now();
					if (message.type === "progress") {
						job.processedBytes = message.processedBytes ?? 0;
						job.totalBytes = message.totalBytes ?? 0;
					} else if (message.type === "result" && message.result) {
						outcome = true;
						job.result = message.result;
						job.processedBytes = job.totalBytes = message.result.fileBytes;
					} else if (message.type === "error") {
						outcome = true;
						workerError = new Error(message.error ?? "Maintenance scan failed");
					}
				},
			);
			worker.once("error", (error) => {
				workerError = error;
			});
			worker.once("exit", (code) => {
				if (job.status === "cancelling") resolve();
				else if (workerError) reject(workerError);
				else if (!outcome) reject(new Error(`Maintenance worker exited (${code})`));
				else resolve();
			});
		});
	}
}
