import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ProjectChannelFence } from "./database";
import type {
	ChannelActor,
	ChannelFence,
	ChannelManageParams,
	ChannelManageResult,
	ChannelMessage,
	ChannelReadParams,
	ChannelReadResult,
	ChannelSnapshotEntry,
	DeleteFingerprint,
} from "./types";
export interface ChannelDatabaseServiceOptions {
	agentDir: string;
	workerPath?: string;
}
export interface ChannelServiceOptions extends ChannelDatabaseServiceOptions {
	projectRoot: string;
	database?: ChannelDatabaseService;
}

/** One worker for all projects belonging to a backend. */
export class ChannelDatabaseService {
	private worker?: Worker;
	private sequence = 0;
	private disposed = false;
	private closing?: Promise<void>;
	private idleClosing?: Promise<void>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private accepted = new Set<Promise<unknown>>();
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	constructor(private readonly options: ChannelDatabaseServiceOptions) {}
	private start(): Worker {
		if (this.worker) return this.worker;
		const dir = dirname(fileURLToPath(import.meta.url));
		const source = join(dir, "worker.ts");
		const path = this.options.workerPath ?? (existsSync(source) ? source : join(dir, "channels-worker.mjs"));
		// Source dependencies use extensionless imports. Register a worker-only resolver for them.
		// The store and JsonStore contain parameter properties, which Node's strip-only mode cannot run.
		const loader = `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)}); const ts = require('typescript'); export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e}} export async function load(url,ctx,next){if(url.startsWith('file:')&&url.endsWith('.ts')){const {readFile}=await import('node:fs/promises');return {format:'module',shortCircuit:true,source:ts.transpileModule(await readFile(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText}}return next(url,ctx)}`;
		const loaderUrl = `data:text/javascript,${encodeURIComponent(loader)}`;
		const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(loaderUrl)}, import.meta.url);`;
		const worker = new Worker(path, {
			workerData: this.options,
			execArgv: path.endsWith(".ts")
				? ["--experimental-strip-types", "--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`]
				: [],
		});
		this.worker = worker;
		worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error !== undefined) pending.reject(new Error(message.error));
			else pending.resolve(message.result);
			if (!this.pending.size) {
				worker.unref();
				this.scheduleIdle(worker);
			}
		});
		const fail = (error: Error) => {
			if (this.worker !== worker) return;
			this.worker = undefined;
			this.clearIdle();
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
		};
		worker.on("error", fail);
		worker.on("exit", (code) => fail(new Error(`Channel worker exited (${code})`)));
		worker.unref();
		return worker;
	}
	private clearIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
	private scheduleIdle(worker: Worker): void {
		if (this.disposed || this.idleClosing || this.worker !== worker || this.pending.size) return;
		this.clearIdle();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.worker !== worker || this.pending.size || this.disposed) return;
			const closing = (async () => {
				try {
					await this.send<void>(worker, "close", []);
				} catch {
					// A failed worker still needs termination before a replacement opens the database.
				} finally {
					await worker.terminate();
					if (this.worker === worker) this.worker = undefined;
				}
			})();
			this.idleClosing = closing.finally(() => {
				this.idleClosing = undefined;
			});
		}, 30_000);
		this.idleTimer.unref();
	}
	call<T>(method: string, args: unknown[] = [], projectRoot?: string): Promise<T> {
		if (this.disposed) return Promise.reject(new Error("Channel service closed"));
		this.clearIdle();
		const request = (async () => {
			if (this.idleClosing) await this.idleClosing;
			return this.send<T>(this.start(), method, args, projectRoot);
		})();
		this.accepted.add(request);
		void request.then(
			() => this.accepted.delete(request),
			() => this.accepted.delete(request),
		);
		return request;
	}
	private send<T>(worker: Worker, method: string, args: unknown[], projectRoot?: string): Promise<T> {
		const id = ++this.sequence;
		worker.ref();
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			try {
				worker.postMessage({ id, method, args, projectRoot });
			} catch (error) {
				this.pending.delete(id);
				if (!this.pending.size) {
					worker.unref();
					this.scheduleIdle(worker);
				}
				reject(error);
			}
		});
	}
	register(root: string): Promise<void> {
		return this.call("register", [root]);
	}
	bind(id: string, root: string, cwd: string): Promise<void> {
		return this.call("bind", [id, root, cwd]);
	}
	binding(id: string): Promise<{ root: string; cwd: string } | undefined> {
		return this.call("binding", [id]);
	}
	deleteFingerprint(root: string, opId: string): Promise<DeleteFingerprint | null | undefined> {
		return this.call("deleteFingerprint", [root, opId]);
	}
	recordDeleteFingerprint(root: string, opId: string, fingerprint: DeleteFingerprint | null): Promise<void> {
		return this.call("recordDeleteFingerprint", [root, opId, fingerprint]);
	}
	fences(): Promise<ProjectChannelFence[]> {
		return this.call("fences");
	}
	find(id: string, source: string): Promise<ProjectChannelFence | undefined> {
		return this.call("find", [id, source]);
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.disposed = true;
		this.clearIdle();
		this.closing = (async () => {
			if (this.idleClosing) await this.idleClosing;
			await Promise.allSettled(this.accepted);
			const worker = this.worker;
			if (!worker) return;
			try {
				await this.send<void>(worker, "close", []);
			} finally {
				await worker.terminate();
				if (this.worker === worker) this.worker = undefined;
			}
		})();
		return this.closing;
	}
}

/** A project-scoped view. Closing a borrowed view never closes its shared worker. */
export class ChannelService {
	readonly projectRoot: string;
	readonly database: ChannelDatabaseService;
	private readonly ownsDatabase: boolean;
	constructor(options: ChannelServiceOptions) {
		this.projectRoot = resolve(options.projectRoot);
		this.database =
			options.database ??
			new ChannelDatabaseService({ agentDir: options.agentDir, workerPath: options.workerPath });
		this.ownsDatabase = !options.database;
	}
	private call<T>(method: string, args: unknown[] = []): Promise<T> {
		return this.database.call(method, args, this.projectRoot);
	}
	manage(actor: ChannelActor, params: ChannelManageParams): Promise<ChannelManageResult> {
		return this.call("manage", [actor, params]);
	}
	snapshot(sessionId: string): Promise<ChannelSnapshotEntry[]> {
		return this.call("snapshot", [sessionId]);
	}
	post(actor: ChannelActor, topic: string, message: string, callId: string): Promise<ChannelMessage> {
		return this.call("post", [actor, topic, message, callId]);
	}
	read(actor: ChannelActor, params: ChannelReadParams, callId: string): Promise<ChannelReadResult> {
		return this.call("read", [actor, params, callId]);
	}
	prepareMaintenance(
		sessionId: string,
		opId: string,
		kind: "archive" | "delete",
		source: string,
	): Promise<void> {
		return this.call("prepareMaintenance", [sessionId, opId, kind, source]);
	}
	completeMaintenance(
		sessionId: string,
		opId: string,
		outcome: "archived" | "active" | "deleted",
	): Promise<void> {
		return this.call("completeMaintenance", [sessionId, opId, outcome]);
	}
	pendingMaintenance(): Promise<ChannelFence[]> {
		return this.call("pendingMaintenance");
	}
	close(): Promise<void> {
		return this.ownsDatabase ? this.database.close() : Promise.resolve();
	}
}
