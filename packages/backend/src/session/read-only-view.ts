import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SourceSnapshot } from "./source-snapshot";

/** 借用真正运行者的公开读取面，不创建第二个AgentSession或模型上下文。 */
export type RunningSessionSource = Pick<
	AgentSession,
	| "sessionId"
	| "sessionFile"
	| "sessionManager"
	| "model"
	| "sessionName"
	| "messages"
	| "isStreaming"
	| "isCompacting"
	| "compactionPause"
	| "pendingMessageCount"
	| "resourceLoader"
	| "thinkingLevel"
	| "getContextUsage"
	| "getSessionStats"
	| "getFollowUpMessages"
	| "getAllTools"
	| "getActiveToolNames"
>;
type ReadManager = Pick<
	SessionManager,
	| "getHeader"
	| "getEntries"
	| "getBranch"
	| "getEntry"
	| "getEntryCount"
	| "getLeafId"
	| "getLeafEntry"
	| "getTree"
	| "getSessionDir"
	| "getSessionName"
	| "getCwd"
	| "getSessionFile"
	| "getSessionId"
	| "buildSessionContext"
>;

export class ReadOnlySessionView {
	private closed = false;
	private cached?: { snapshot: SourceSnapshot; manager: SessionManager };
	constructor(
		readonly sessionId: string,
		readonly sessionFile: string,
		readonly sourceOwner: object,
		private readonly options: {
			snapshot: () => SourceSnapshot;
			running: () => RunningSessionSource | undefined;
			exportHtml: (snapshot: SourceSnapshot, output: string) => Promise<string>;
		},
	) {}
	get snapshot(): SourceSnapshot {
		if (this.closed) throw new Error("Read-only view was disposed");
		return this.options.snapshot();
	}
	private live(): RunningSessionSource | undefined {
		return this.closed ? undefined : this.options.running();
	}
	private manager(): SessionManager {
		const snapshot = this.snapshot;
		if (!snapshot.header) throw new Error("Read-only source has no header");
		if (this.cached?.snapshot !== snapshot)
			this.cached = {
				snapshot,
				manager: SessionManager.inMemory(snapshot.header.cwd || process.cwd(), undefined, [
					snapshot.header,
					...snapshot.entries,
				]),
			};
		return this.cached.manager;
	}
	get sessionManager(): ReadManager {
		return this.live()?.sessionManager ?? this.manager();
	}
	get cwd(): string {
		return this.sessionManager.getCwd();
	}
	get sessionName(): string | undefined {
		const live = this.live();
		return live ? live.sessionName : this.manager().getSessionName();
	}
	get model(): Pick<NonNullable<AgentSession["model"]>, "id" | "provider" | "name"> | undefined {
		const live = this.live();
		if (live) return live.model;
		const model = this.manager().buildSessionContext().model;
		return model ? { id: model.modelId, provider: model.provider, name: model.modelId } : undefined;
	}
	get thinkingLevel(): string {
		return this.live()?.thinkingLevel ?? this.manager().buildSessionContext().thinkingLevel;
	}
	get messages() {
		return this.live()?.messages ?? this.manager().buildSessionContext().messages;
	}
	get isStreaming(): boolean {
		return this.live()?.isStreaming ?? false;
	}
	get isCompacting(): boolean {
		return this.live()?.isCompacting ?? false;
	}
	get compactionPause() {
		return this.live()?.compactionPause;
	}
	get pendingMessageCount(): number {
		return this.live()?.pendingMessageCount ?? 0;
	}
	getFollowUpMessages(): ReturnType<AgentSession["getFollowUpMessages"]> {
		return this.live()?.getFollowUpMessages() ?? [];
	}
	getAllTools() {
		return this.live()?.getAllTools() ?? [];
	}
	getActiveToolNames(): string[] {
		return this.live()?.getActiveToolNames() ?? [];
	}
	getContextUsage(): ReturnType<AgentSession["getContextUsage"]> {
		return this.live()?.getContextUsage();
	}
	getSessionStats(): ReturnType<AgentSession["getSessionStats"]> {
		const live = this.live();
		if (live) return live.getSessionStats();
		const messages = this.messages,
			tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		let cost = 0;
		const add = (usage: unknown) => {
			if (!usage || typeof usage !== "object") return;
			const value = usage as Record<string, unknown>;
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
				if (typeof value[key] === "number" && Number.isFinite(value[key])) tokens[key] += value[key];
			const amount =
				value.cost && typeof value.cost === "object" ? (value.cost as { total?: unknown }).total : undefined;
			if (typeof amount === "number" && Number.isFinite(amount)) cost += amount;
		};
		for (const entry of this.sessionManager.getBranch()) {
			if (
				entry.type === "message" &&
				(entry.message.role === "assistant" || entry.message.role === "toolResult")
			)
				add(entry.message.usage);
			else if (entry.type === "usage") add(entry.usage);
		}
		tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages: messages.filter((message) => message.role === "user").length,
			assistantMessages: messages.filter((message) => message.role === "assistant").length,
			toolResults: messages.filter((message) => message.role === "toolResult").length,
			toolCalls: messages.reduce(
				(sum, message) =>
					sum +
					(message.role === "assistant"
						? message.content.filter((block) => block.type === "toolCall").length
						: 0),
				0,
			),
			totalMessages: messages.length,
			tokens,
			cost,
		};
	}
	async exportToHtml(output: string): Promise<string> {
		return this.options.exportHtml(this.snapshot, output);
	}
	async abort(): Promise<void> {
		/* 视图不拥有真实运行者；停止操作由后端路由到run handle。 */
	}
	async shutdown(): Promise<void> {
		this.dispose();
	}
	dispose(): void {
		this.closed = true;
		this.cached = undefined;
	}
}
