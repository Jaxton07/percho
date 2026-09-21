import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionMeta } from "@percho/shared";
import type { PermissionModeRef } from "../permissions/extension";
import type { PermissionGate } from "../permissions/gate";
import type { ExtensionDialogHost } from "./extension-dialog-host";
import { deriveSessionTimes, fallbackSessionTimes } from "./meta";

export interface RegisteredSession {
	session: AgentSession;
	unsubscribe: () => void;
	cwd: string;
	/** 只读会话（subagent 产物检视）：prompt/fork/recall/setModel 等写操作全部拒绝 */
	readOnly?: boolean;
	/** 会话级权限确认队列（会话生命周期内唯一，随 entry 清理） */
	gate: PermissionGate;
	/** 扩展对话框宿主（每会话一个；GUI 停靠槽数据源，GUI-only 不进 LAN） */
	dialogs: ExtensionDialogHost;
	/** 会话权限模式引用（default 缺省；随工厂闭包注入求值链，不落盘） */
	modeRef: PermissionModeRef;
}

/** 维护 sessionId → AgentSession 实例（会话级状态单条记录：gate/dialogs/modeRef 都在 entry 上） */
export class SessionRegistry {
	private readonly sessions = new Map<string, RegisteredSession>();

	/**
	 * 注册会话。同 sessionId 重复 add **同一个 entry** = 幂等；
	 * 不同 entry = 抛错，**绝不静默覆盖**：覆盖会把第一份实例的订阅/gate/dialogs 全泄漏，
	 * 而且再没人能 dispose 它。正常主路径走不到这里（`PiBackend.openSession` 在构造前就按
	 * sessionId 短路），这是并发/别名路径的最后防线；调用方负责清理刚构造的实例（见 wireSession）。
	 */
	add(entry: RegisteredSession): void {
		const existing = this.sessions.get(entry.session.sessionId);
		if (existing && existing !== entry) {
			throw new Error(`Session already registered: ${entry.session.sessionId}`);
		}
		this.sessions.set(entry.session.sessionId, entry);
	}

	get(sessionId: string): RegisteredSession | undefined {
		return this.sessions.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** entry 级清理：退订事件 + 权限队列/对话框宿主 dispose（session.dispose 由调用方先做，见 closeSession） */
	delete(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		entry.unsubscribe();
		entry.gate.dispose();
		entry.dialogs.dispose();
		this.sessions.delete(sessionId);
	}

	list(): RegisteredSession[] {
		return [...this.sessions.values()];
	}

	toMeta(entry: RegisteredSession): SessionMeta {
		const { session, cwd } = entry;
		// 时间口径唯一出处见 meta.ts（spec D1）：header + entries 权威（与 SDK 磁盘枚举同语义，
		// 不能用文件 birthtime/mtime 替代——复制/恢复文件会改 birthtime，channel cursor 等
		// custom entry 也不该影响排序）；只有 header 读不出来时才退化到文件时间。
		const times =
			deriveSessionTimes(session.sessionManager.getHeader(), session.sessionManager.getEntries()) ??
			fallbackSessionTimes(session.sessionFile);
		return {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd,
			name: session.sessionName,
			modelLabel: session.model?.name,
			model: session.model ? { provider: session.model.provider, modelId: session.model.id } : null,
			thinkingLevel: session.thinkingLevel,
			active: true,
			messageCount: session.messages.length,
			createdAt: times.createdAt,
			modifiedAt: times.modifiedAt,
			readOnly: entry.readOnly || undefined,
		};
	}

	disposeAll(): void {
		// 与 closeSession 对称：逐 entry 全量清理（closeSession 已 dispose 的不在
		// registry，无双重释放路径）；清空 Map
		for (const [sessionId, entry] of [...this.sessions.entries()]) {
			entry.unsubscribe();
			entry.gate.dispose();
			entry.dialogs.dispose();
			entry.session.dispose();
			this.sessions.delete(sessionId);
		}
	}
}

export type EventForwarder = (sessionId: string, event: AgentSessionEvent) => void;
