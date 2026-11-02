import { type AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CacheWarmingInfo, CacheWarmingMode, CacheWarmingSessionStatus } from "@percho/shared";

type Session = Pick<
	AgentSession,
	"sessionId" | "sessionName" | "settingsManager" | "cacheWarmingStatus" | "setCacheWarmingMode"
>;

function reasonCode(reason: string | undefined): CacheWarmingSessionStatus["reason"] {
	if (!reason) return undefined;
	if (reason === "cache warming disabled") return "disabled";
	if (reason === "waiting for first request") return "waiting";
	if (reason === "agent run settled") return "settled";
	if (reason.includes("economics") || reason.includes("savings")) return "uneconomical";
	if (
		reason.includes("unavailable") ||
		reason.includes("cannot be replayed") ||
		reason.includes("disabled prompt caching")
	)
		return "unsupported";
	if (reason.includes("context changed")) return "changed";
	if (reason.includes("limit") || reason.includes("deadline")) return "limit";
	return "other";
}

/** 使用 SDK 的全局设置写入与公开会话 API；保存和会话注册串行，避免构造中的会话漏掉更新。 */
export class CacheWarmingSettings {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly agentDir: () => string,
		private readonly sessions: () => Session[],
	) {}
	private manager() {
		return SettingsManager.create(process.cwd(), this.agentDir(), { projectTrusted: false });
	}
	get(): CacheWarmingInfo {
		return {
			mode: this.manager().getCacheWarmingMode(),
			sessions: this.sessions().map((session) => {
				const status = session.cacheWarmingStatus;
				return {
					sessionId: session.sessionId,
					name: session.sessionName || session.sessionId.slice(0, 8),
					mode: session.settingsManager.getCacheWarmingMode(),
					state: status?.state ?? "unavailable",
					reason: reasonCode(status?.reason),
					nextWarmAt: status?.nextWarmAt,
					phase: status?.decision?.phase,
				};
			}),
		};
	}
	private run<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work, work);
		this.queue = next.catch(() => {});
		return next;
	}
	private async apply(session: Session, mode: CacheWarmingMode) {
		if (session.settingsManager.getCacheWarmingMode() === mode) return;
		session.setCacheWarmingMode(mode);
		await session.settingsManager.flush();
		const failure = session.settingsManager.drainErrors()[0];
		if (failure) throw failure.error;
	}
	register(session: Session, register: () => void): Promise<void> {
		return this.run(async () => {
			await this.apply(session, this.manager().getCacheWarmingMode());
			register();
		});
	}
	set(mode: CacheWarmingMode): Promise<CacheWarmingInfo> {
		return this.run(async () => {
			const manager = this.manager();
			const loadError = manager.drainErrors().find((error) => error.scope === "global");
			if (loadError) throw loadError.error;
			manager.setCacheWarmingMode(mode);
			await manager.flush();
			const saveError = manager.drainErrors()[0];
			if (saveError) throw saveError.error;
			const updates = await Promise.allSettled(this.sessions().map((session) => this.apply(session, mode)));
			const failed = updates.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			return this.get();
		});
	}
}
