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

	wait(sessionId: string, token = "legacy"): Promise<boolean> {
		const key = JSON.stringify([sessionId, token]);
		if (this.ready.has(key)) return Promise.resolve(true);
		const existing = this.pending.get(key);
		if (existing) return existing.promise;
		let release = (_allowed: boolean) => {};
		const promise = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const timer = setTimeout(() => this.ack(sessionId, token), this.timeoutMs);
		this.pending.set(key, { promise, release, timer });
		return promise;
	}

	ack(sessionId: string, token = "legacy"): void {
		const key = JSON.stringify([sessionId, token]);
		this.ready.add(key);
		this.release(key, true);
	}

	cancel(sessionId: string, token = "legacy"): void {
		const key = JSON.stringify([sessionId, token]);
		this.ready.delete(key);
		this.release(key, false);
	}

	dispose(): void {
		for (const key of this.pending.keys()) this.release(key, false);
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
