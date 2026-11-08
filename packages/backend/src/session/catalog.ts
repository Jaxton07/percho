import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
	SessionCatalogChange,
	SessionCatalogPage,
	SessionCatalogProjects,
	SessionCatalogQuery,
	SessionCatalogReference,
	SessionCatalogVerification,
} from "@percho/shared";

export interface CatalogArchiveProjection {
	path: string;
	archivedAt?: number;
	archiveRevision: number;
	archiveCleanupPending?: boolean;
}

/** A single worker owns the disposable index; no SDK or synchronous SQLite on the host thread. */
export class SessionCatalog {
	private worker?: Worker;
	private sequence = 0;
	private readonly archiveOverlay = new Map<string, CatalogArchiveProjection>();
	private readonly dirtyArchives = new Set<string>();
	private snapshotKnown = false;
	private snapshotDirty = false;
	private archiveUpdates: Promise<void> = Promise.resolve();
	private disposed = false;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	constructor(
		private readonly options: {
			sessionsDir: string;
			indexPath: string;
			onChange?: (change: SessionCatalogChange) => void;
			workerPath?: string;
		},
	) {}
	private start(): Worker {
		if (this.disposed) throw new Error("Session catalog disposed");
		if (this.worker) return this.worker;
		const directory = dirname(fileURLToPath(import.meta.url));
		const source = join(directory, "catalog-worker.ts");
		const path =
			this.options.workerPath ??
			(existsSync(source) ? source : join(directory, "session-catalog-worker.mjs"));
		const worker = new Worker(path, {
			workerData: {
				sessionsDir: this.options.sessionsDir,
				indexPath: this.options.indexPath,
				archives: [...this.archiveOverlay.values()],
				archiveSnapshotKnown: this.snapshotKnown,
			},
			execArgv: path.endsWith(".ts") ? ["--experimental-strip-types"] : [],
			resourceLimits: { maxOldGenerationSizeMb: 384 },
		});
		this.worker = worker;
		worker.on(
			"message",
			(message: {
				id?: number;
				result?: unknown;
				error?: string;
				event?: string;
				data?: SessionCatalogChange;
			}) => {
				if (message.event === "changed" && message.data) this.options.onChange?.(message.data);
				if (message.id === undefined) return;
				const request = this.pending.get(message.id);
				if (!request) return;
				this.pending.delete(message.id);
				if (message.error) request.reject(new Error(message.error));
				else request.resolve(message.result);
				if (this.pending.size === 0) worker.unref();
			},
		);
		const fail = (error: Error) => {
			if (this.worker !== worker) return;
			this.worker = undefined;
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
		};
		worker.on("error", fail);
		worker.on("exit", (code) => fail(new Error(`Session catalog worker exited (${code})`)));
		worker.unref();
		return worker;
	}
	private call<T>(method: string, params?: unknown): Promise<T> {
		const worker = this.start();
		const id = ++this.sequence;
		worker.ref();
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			try {
				worker.postMessage({ id, method, params });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	private async flushArchives(): Promise<void> {
		await this.archiveUpdates.catch(() => {});
		if (this.snapshotDirty) {
			await this.setArchiveOverlay([...this.archiveOverlay.values()]);
		}
		for (const path of [...this.dirtyArchives]) {
			const projection = this.archiveOverlay.get(path);
			if (projection) await this.setArchive(projection);
		}
	}
	async projects(): Promise<SessionCatalogProjects> {
		await this.flushArchives();
		return this.call("projects");
	}
	async query(query: SessionCatalogQuery): Promise<SessionCatalogPage> {
		await this.flushArchives();
		return this.call("query", query);
	}
	async verify(references: SessionCatalogReference[]): Promise<SessionCatalogVerification[]> {
		await this.flushArchives();
		return this.call("verify", references);
	}
	refresh(): Promise<void> {
		return this.call("refresh");
	}
	invalidate(path: string): Promise<void> {
		return this.call("invalidate", { path });
	}
	remove(path: string): Promise<void> {
		return this.call("remove", { path });
	}
	setArchive(projection: CatalogArchiveProjection): Promise<void> {
		this.archiveOverlay.set(projection.path, { ...projection });
		this.dirtyArchives.add(projection.path);
		const update = this.archiveUpdates
			.catch(() => {})
			.then(async () => {
				const current = this.archiveOverlay.get(projection.path);
				if (!current) return;
				await this.call("archive", current);
				if (this.archiveOverlay.get(projection.path) === current) this.dirtyArchives.delete(projection.path);
			});
		this.archiveUpdates = update;
		return update;
	}
	setArchiveOverlay(projections: CatalogArchiveProjection[]): Promise<void> {
		const snapshot = projections.map((projection) => ({ ...projection }));
		this.archiveOverlay.clear();
		for (const projection of snapshot) this.archiveOverlay.set(projection.path, projection);
		this.snapshotKnown = true;
		this.snapshotDirty = true;
		const update = this.archiveUpdates
			.catch(() => {})
			.then(async () => {
				await this.call("archiveSnapshot", snapshot);
				if (this.archiveUpdates === update) {
					this.snapshotDirty = false;
					this.dirtyArchives.clear();
				}
			});
		this.archiveUpdates = update;
		return update;
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		const worker = this.worker;
		if (!worker) {
			this.disposed = true;
			return;
		}
		try {
			await this.call("dispose");
		} finally {
			this.disposed = true;
			await worker.terminate();
		}
	}
}
