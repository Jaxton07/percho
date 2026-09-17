import { statSync } from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionMeta } from "@percho/shared";
import type { PermissionModeRef } from "../permissions/extension";
import type { PermissionGate } from "../permissions/gate";
import type { ExtensionDialogHost } from "./extension-dialog-host";

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

	add(entry: RegisteredSession): void {
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
		// createdAt 用会话文件创建时刻（fork = fork 时刻，语义真实）；SDK 无活跃会话 created 访问器
		let createdAt = Date.now();
		if (session.sessionFile) {
			try {
				createdAt = statSync(session.sessionFile).birthtimeMs;
			} catch {
				// 文件不存在/异常回退当前时刻
			}
		}
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
			createdAt,
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
