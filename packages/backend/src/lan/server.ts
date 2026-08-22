import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
	LanSessionBrief,
	LanSessionView,
	LanSseFrame,
	LanStatus,
	PermissionRequest,
	SessionEvent,
	SessionMessage,
	SessionMeta,
} from "@percho/shared";
import type { LanConfigService } from "./config";
import {
	applyEvent,
	applyPermissionRequest,
	applyPermissionResolved,
	type LanPendingPermission,
	seedView,
} from "./projector";

const CLIENT_LIMIT = 5;
const CLIENT_QUEUE_LIMIT = 256;
const DIRTY_FLUSH_MS = 120;
const PING_MS = 20_000;
const RECONCILE_MS = 60_000;
const MAX_PENDING_SESSIONS = 32;
const MAX_PENDING_EVENTS_PER_SESSION = 64;
const MAX_UNSEEDABLE_SESSIONS = 256;

/** LAN server 所需的 PiBackend 只读/订阅面；方便无 SDK 的单测替身。 */
export interface LanObserverBackend {
	listAllSessions(): Promise<SessionMeta[]>;
	getSessionMessages(sessionId: string): Promise<SessionMessage[]>;
	getTodos(sessionId: string): Promise<LanSessionView["todos"]>;
	getStats(sessionId: string): Promise<NonNullable<LanSessionView["stats"]>>;
	listActiveSessionRuntime(): Array<{ sessionId: string; streaming: boolean; compacting: boolean }>;
	getPendingPermissionRequests(): Array<{
		sessionId: string;
		title: string;
		message: string;
		kind: string;
	}>;
	onEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void;
	onPermissionRequest(handler: (req: PermissionRequest) => void): () => void;
	onPermissionResolved(
		handler: (result: { sessionId: string; requestId: string; answered: boolean }) => void,
	): () => void;
}

interface SseClient {
	res: ServerResponse;
	queue: string[];
	blocked: boolean;
}

export interface LanObserverServerOptions {
	pageHtml: string;
}

/** 默认关闭时零资源；启动后才订阅 backend 并提供只读 HTTP/SSE 投影。 */
export class LanObserverServer {
	private server: Server | null = null;
	private port: number | null = null;
	private readonly views = new Map<string, LanSessionView>();
	private readonly dirty = new Set<string>();
	/** 首个事件到达而尚未完成快照种子的会话，逐会话有界缓存。 */
	private readonly pendingEvents = new Map<string, SessionEvent[]>();
	/** 同一未知 session 只能有一个 listAllSessions 种子请求在途。 */
	private readonly seedInFlight = new Map<string, Promise<void>>();
	/** 未出现在最近一次快照的 session（典型为 sessions-subagents）；reconcile 时清空以允许重试。 */
	private readonly unseedableSessions = new Set<string>();
	private readonly clients = new Set<SseClient>();
	private list: LanSessionBrief[] = [];
	private seq = 0;
	private unsubscribers: Array<() => void> = [];
	private dirtyTimer: ReturnType<typeof setInterval> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly backend: LanObserverBackend,
		private readonly config: LanConfigService,
		private readonly options: LanObserverServerOptions,
	) {}

	async start(): Promise<void> {
		if (this.server) return;
		const config = await this.config.load();
		if (!config.token) throw new Error("LAN observer token is not configured");

		const server = createServer((req, res) => void this.handleRequest(req, res));
		const port = await listenWithRetry(server, config.port);
		this.server = server;
		this.port = port;
		await this.reconcile();
		this.unsubscribers = [
			this.backend.onEvent((sessionId, event) => this.handleEvent(sessionId, event)),
			this.backend.onPermissionRequest((req) => this.handlePermissionRequest(req)),
			this.backend.onPermissionResolved((result) => this.handlePermissionResolved(result.sessionId)),
		];
		this.dirtyTimer = setInterval(() => this.flushDirty(), DIRTY_FLUSH_MS);
		this.pingTimer = setInterval(() => this.broadcastRaw(": ping\n\n"), PING_MS);
		this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_MS);
	}

	async stop(): Promise<void> {
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		if (this.dirtyTimer) clearInterval(this.dirtyTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		this.dirtyTimer = null;
		this.pingTimer = null;
		this.reconcileTimer = null;
		for (const client of this.clients) client.res.end();
		this.clients.clear();
		const server = this.server;
		this.server = null;
		this.port = null;
		this.views.clear();
		this.dirty.clear();
		this.pendingEvents.clear();
		this.seedInFlight.clear();
		this.unseedableSessions.clear();
		this.list = [];
		server?.closeAllConnections?.();
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	status(): LanStatus {
		return {
			enabled: this.server !== null,
			port: this.port,
			urls: [],
			qrDataUrl: null,
			clients: this.clients.size,
		};
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method !== "GET") return this.sendJson(res, 404, { error: "not found" });
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(this.options.pageHtml);
			return;
		}
		if (url.pathname !== "/api/snapshot" && url.pathname !== "/api/stream") {
			return this.sendJson(res, 404, { error: "not found" });
		}
		if (!(await this.authorized(url.searchParams.get("t")))) {
			return this.sendJson(res, 401, { error: "invalid token" });
		}
		if (url.pathname === "/api/snapshot") {
			this.sendJson(res, 200, { serverTime: Date.now(), list: this.list, views: [...this.views.values()] });
			return;
		}
		this.openStream(req, res);
	}

	private async authorized(token: string | null): Promise<boolean> {
		const expected = (await this.config.load()).token;
		if (!token || !expected) return false;
		const suppliedBuffer = Buffer.from(token, "base64url");
		const expectedBuffer = Buffer.from(expected, "base64url");
		return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
	}

	private sendJson(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	}

	private openStream(req: IncomingMessage, res: ServerResponse): void {
		if (this.clients.size >= CLIENT_LIMIT) {
			this.sendJson(res, 403, { error: "too many clients" });
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
		});
		const client: SseClient = { res, queue: [], blocked: false };
		this.clients.add(client);
		this.sendFrame(client, { event: "hello", data: { seq: this.seq } });
		for (const view of this.views.values()) this.sendFrame(client, this.viewFrame(view));
		req.on("close", () => this.clients.delete(client));
		res.on("drain", () => this.flushClient(client));
	}

	private handleEvent(sessionId: string, event: SessionEvent): void {
		const view = this.views.get(sessionId);
		if (view) {
			this.views.set(sessionId, applyEvent(view, event));
			this.dirty.add(sessionId);
			return;
		}
		// 子代理子会话也会转发原生事件，却不在 listAllSessions（物理隔离）中；
		// 对已知不可种子的 id 直接丢弃，避免每个 delta 都触发磁盘扫描。
		if (this.unseedableSessions.has(sessionId)) return;
		let events = this.pendingEvents.get(sessionId);
		if (!events) {
			if (this.pendingEvents.size >= MAX_PENDING_SESSIONS) return;
			events = [];
			this.pendingEvents.set(sessionId, events);
		}
		if (events.length < MAX_PENDING_EVENTS_PER_SESSION) events.push(event);
		void this.seedSession(sessionId);
	}

	private handlePermissionRequest(req: PermissionRequest): void {
		const view = this.views.get(req.sessionId);
		if (view) {
			this.views.set(req.sessionId, applyPermissionRequest(view, req));
			this.dirty.add(req.sessionId);
			return;
		}
		void this.seedSession(req.sessionId);
	}

	private handlePermissionResolved(sessionId: string): void {
		const view = this.views.get(sessionId);
		if (!view) return;
		this.views.set(sessionId, applyPermissionResolved(view));
		this.dirty.add(sessionId);
	}

	private async reconcile(): Promise<void> {
		const sessions = await this.backend.listAllSessions();
		// 下一个对账周期允许未知 session 再试一次（例如刚创建、尚未落盘的主会话）。
		this.unseedableSessions.clear();
		const nextList = sessions.map(toBrief);
		const listChanged = JSON.stringify(nextList) !== JSON.stringify(this.list);
		this.list = nextList;
		const activeIds = new Set(
			sessions.filter((session) => session.active).map((session) => session.sessionId),
		);
		for (const id of this.views.keys()) if (!activeIds.has(id)) this.views.delete(id);
		await Promise.all([...activeIds].map((sessionId) => this.seedSession(sessionId, sessions)));
		if (listChanged) this.broadcast(this.listFrame());
	}

	private seedSession(
		sessionId: string,
		sessions?: Awaited<ReturnType<LanObserverBackend["listAllSessions"]>>,
	): Promise<void> {
		if (this.views.has(sessionId) || (!sessions && this.unseedableSessions.has(sessionId)))
			return Promise.resolve();
		const existing = this.seedInFlight.get(sessionId);
		if (existing) return existing;
		const seed = this.seedSessionImpl(sessionId, sessions).finally(() => this.seedInFlight.delete(sessionId));
		this.seedInFlight.set(sessionId, seed);
		return seed;
	}

	private async seedSessionImpl(
		sessionId: string,
		sessions?: Awaited<ReturnType<LanObserverBackend["listAllSessions"]>>,
	): Promise<void> {
		if (this.views.has(sessionId)) return;
		const all = sessions ?? (await this.backend.listAllSessions());
		const meta = all.find((session) => session.sessionId === sessionId && session.active);
		if (!meta) {
			this.pendingEvents.delete(sessionId);
			this.markUnseedable(sessionId);
			return;
		}
		const runtime = this.backend.listActiveSessionRuntime().find((item) => item.sessionId === sessionId);
		const pending = this.pendingPermission(sessionId);
		const [todos, stats, messages] = await Promise.all([
			this.backend.getTodos(sessionId).catch(() => []),
			this.backend.getStats(sessionId).catch(() => null),
			this.backend.getSessionMessages(sessionId).catch(() => []),
		]);
		let view = seedView(meta, runtime, todos, stats, assistantTail(messages), pending);
		for (const event of this.pendingEvents.get(sessionId) ?? []) view = applyEvent(view, event);
		this.pendingEvents.delete(sessionId);
		this.views.set(sessionId, view);
		this.dirty.add(sessionId);
	}

	private markUnseedable(sessionId: string): void {
		if (this.unseedableSessions.size >= MAX_UNSEEDABLE_SESSIONS) {
			const oldest = this.unseedableSessions.values().next().value;
			if (oldest) this.unseedableSessions.delete(oldest);
		}
		this.unseedableSessions.add(sessionId);
	}

	private pendingPermission(sessionId: string): LanPendingPermission | null {
		const pending = this.backend
			.getPendingPermissionRequests()
			.find((request) => request.sessionId === sessionId);
		return pending ? { title: pending.title, message: pending.message, kind: pending.kind } : null;
	}

	private flushDirty(): void {
		for (const sessionId of this.dirty) {
			const view = this.views.get(sessionId);
			if (view) this.broadcast(this.viewFrame(view));
		}
		this.dirty.clear();
	}

	private viewFrame(view: LanSessionView): Extract<LanSseFrame, { event: "view" }> {
		return { event: "view", data: { sessionId: view.sessionId, view, seq: ++this.seq } };
	}

	private listFrame(): Extract<LanSseFrame, { event: "list" }> {
		return { event: "list", data: { list: this.list, seq: ++this.seq } };
	}

	private broadcast(frame: LanSseFrame): void {
		for (const client of this.clients) this.sendFrame(client, frame);
	}

	private broadcastRaw(payload: string): void {
		for (const client of this.clients) this.sendRaw(client, payload);
	}

	private sendFrame(client: SseClient, frame: LanSseFrame): void {
		this.sendRaw(client, `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
	}

	private sendRaw(client: SseClient, payload: string): void {
		if (client.blocked) {
			if (client.queue.length >= CLIENT_QUEUE_LIMIT) {
				client.res.destroy();
				this.clients.delete(client);
				return;
			}
			client.queue.push(payload);
			return;
		}
		client.blocked = !client.res.write(payload);
	}

	private flushClient(client: SseClient): void {
		client.blocked = false;
		while (client.queue.length > 0 && !client.blocked) {
			const payload = client.queue.shift();
			if (payload) client.blocked = !client.res.write(payload);
		}
	}
}

function toBrief(
	session: Awaited<ReturnType<LanObserverBackend["listAllSessions"]>>[number],
): LanSessionBrief {
	return {
		sessionId: session.sessionId,
		name: session.name?.trim() || "New session",
		cwd: session.cwd,
		active: session.active,
		modifiedAt: session.modifiedAt ?? session.createdAt,
	};
}

function assistantTail(messages: SessionMessage[]): string | null {
	for (const message of [...messages].reverse()) {
		if (message.role === "assistant" && message.text) return message.text.slice(-2048);
	}
	return null;
}

async function listenWithRetry(server: Server, initialPort: number): Promise<number> {
	let port = initialPort;
	for (let attempt = 0; attempt < 20; attempt++, port++) {
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: NodeJS.ErrnoException) => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(port, "0.0.0.0");
			});
			const address = server.address();
			return typeof address === "object" && address ? address.port : port;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === 19) throw error;
		}
	}
	throw new Error("Unable to listen for LAN observer");
}
