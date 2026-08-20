import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionMeta } from "@percho/shared";

export interface RegisteredSession {
	session: AgentSession;
	unsubscribe: () => void;
	cwd: string;
	/** 只读会话（subagent 产物检视）：prompt/fork/recall/setModel 等写操作全部拒绝 */
	readOnly?: boolean;
}

/** 维护 sessionId → AgentSession 实例 */
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

	delete(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		entry.unsubscribe();
		this.sessions.delete(sessionId);
	}

	list(): RegisteredSession[] {
		return [...this.sessions.values()];
	}

	toMeta(entry: RegisteredSession): SessionMeta {
		const { session, cwd } = entry;
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
			createdAt: Date.now(),
			readOnly: entry.readOnly || undefined,
		};
	}

	disposeAll(): void {
		for (const sessionId of [...this.sessions.keys()]) {
			this.delete(sessionId);
		}
	}
}

export type EventForwarder = (sessionId: string, event: AgentSessionEvent) => void;
