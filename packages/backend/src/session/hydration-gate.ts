/**
 * 只协调「打开后恢复的频道唤醒」与 renderer 首次历史回放。不能在 SDK session_start
 * 中 await renderer：openSession 尚未返回，renderer 根本无从 ACK。
 * 无 renderer（backend/LAN/崩溃）时超时放行，避免频道永久静默；会话处置
 * （disposeSession 里 `historyGate.cancel`）返回 false，防止迟到的等待续体在 dispose
 * 之后启动孤儿 watcher。
 */
export class SessionHydrationGate {
	private readonly pending = new Map<
		string,
		{ promise: Promise<boolean>; release: (allowed: boolean) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private readonly ready = new Set<string>();

	constructor(private readonly timeoutMs = 15_000) {}

	wait(sessionId: string): Promise<boolean> {
		if (this.ready.has(sessionId)) return Promise.resolve(true);
		const existing = this.pending.get(sessionId);
		if (existing) return existing.promise;
		let release = (_allowed: boolean) => {};
		const promise = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const timer = setTimeout(() => this.ack(sessionId), this.timeoutMs);
		this.pending.set(sessionId, { promise, release, timer });
		return promise;
	}

	ack(sessionId: string): void {
		this.ready.add(sessionId);
		this.release(sessionId, true);
	}

	cancel(sessionId: string): void {
		this.ready.delete(sessionId);
		this.release(sessionId, false);
	}

	dispose(): void {
		for (const id of this.pending.keys()) this.cancel(id);
		this.ready.clear();
	}

	private release(sessionId: string, allowed: boolean): void {
		const entry = this.pending.get(sessionId);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(sessionId);
		entry.release(allowed);
	}
}
