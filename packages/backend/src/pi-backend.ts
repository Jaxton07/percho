import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	AvailableModel,
	CreateSessionOptions,
	PermissionAnswer,
	PermissionRequest,
	SessionMeta,
	SessionStats,
} from "@pi-desktop/shared";
import { PermissionGate } from "./permissions";
import { type EventForwarder, SessionRegistry } from "./session-registry";
import { SettingsService } from "./settings";

export interface PiBackendOptions {
	/** 默认工作目录（createSession 未指定时使用） */
	defaultCwd?: string;
	/** 每会话工具白名单；缺省用 pi 默认（read/bash/edit/write） */
	tools?: string[];
	/** 额外自定义工具 */
	customTools?: ToolDefinition[];
	/** 是否启用权限确认门控（false 时 confirm 直接通过） */
	permissionGates?: boolean;
}

type EventHandler = (sessionId: string, event: AgentSessionEvent) => void;
type PermissionHandler = (req: PermissionRequest) => void;

/**
 * PiBackend：pi SDK 的唯一适配层。不依赖 Electron，
 * 主进程与（未来的）独立 server 均可复用。
 */
export class PiBackend {
	private readonly registry = new SessionRegistry();
	private readonly eventHandlers = new Set<EventHandler>();
	private readonly permissionHandlers = new Set<PermissionHandler>();
	private readonly gates = new Map<string, PermissionGate>();
	private modelRuntime: ModelRuntime | undefined;
	private modelPromise: Promise<ModelRuntime> | undefined;
	/** 设置页（provider/模型/凭证配置）服务 */
	readonly settings = new SettingsService(() => this.getModelRuntime());

	constructor(private readonly options: PiBackendOptions = {}) {}

	private async getModelRuntime(): Promise<ModelRuntime> {
		if (this.modelRuntime) return this.modelRuntime;
		if (!this.modelPromise) {
			this.modelPromise = ModelRuntime.create();
		}
		this.modelRuntime = await this.modelPromise;
		return this.modelRuntime;
	}

	private emitEvent(sessionId: string, event: AgentSessionEvent): void {
		for (const handler of this.eventHandlers) {
			try {
				handler(sessionId, event);
			} catch {
				// 事件处理器异常不影响主流程
			}
		}
	}

	private makeUiContext(gate: PermissionGate): ExtensionUIContext {
		return {
			select: (title, options) =>
				gate.confirm(title, options.join(", ")).then((ok) => (ok ? options[0] : undefined)),
			confirm: (title, message) => gate.confirm(title, message),
			input: (title) => gate.confirm(title, "允许输入?").then((ok) => (ok ? "" : undefined)),
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: (async () => undefined) as ExtensionUIContext["custom"],
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: {} as ExtensionUIContext["theme"],
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: true }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	async init(): Promise<void> {
		await this.getModelRuntime();
	}

	async createSession(options: CreateSessionOptions): Promise<SessionMeta> {
		const runtime = await this.getModelRuntime();
		const cwd = options.cwd || this.options.defaultCwd || process.cwd();
		const model =
			options.provider && options.modelId ? runtime.getModel(options.provider, options.modelId) : undefined;

		const gate = new PermissionGate((req) => this.dispatchPermissionRequest(req));

		const { session } = await createAgentSession({
			cwd,
			modelRuntime: runtime,
			model,
			thinkingLevel: options.thinkingLevel as ThinkingLevel | undefined,
			tools: this.options.tools,
			customTools: this.options.customTools,
			sessionManager: SessionManager.create(cwd),
		});

		gate.bindSession(session.sessionId);
		this.gates.set(session.sessionId, gate);
		if (this.options.permissionGates !== false) {
			await session.bindExtensions({
				uiContext: this.makeUiContext(gate),
				mode: "tui",
			});
		}

		const unsubscribe = session.subscribe((event) => this.emitEvent(session.sessionId, event));
		this.registry.add({ session, unsubscribe, cwd });
		return this.toMetaOrThrow(session.sessionId);
	}

	async openSession(filePath: string): Promise<SessionMeta> {
		const runtime = await this.getModelRuntime();
		const sessionManager = SessionManager.open(filePath);
		const cwd = sessionManager.getCwd() || process.cwd();
		const { session } = await createAgentSession({
			sessionManager,
			modelRuntime: runtime,
		});
		const unsubscribe = session.subscribe((event) => this.emitEvent(session.sessionId, event));
		this.registry.add({ session, unsubscribe, cwd });
		return this.toMetaOrThrow(session.sessionId);
	}

	async listSessions(cwd?: string): Promise<SessionMeta[]> {
		const target = cwd || this.options.defaultCwd || process.cwd();
		const infos = await SessionManager.list(target);
		const activeIds = new Set(this.registry.list().map((e) => e.session.sessionId));
		return infos
			.filter((info) => !activeIds.has(info.id))
			.map((info) => ({
				sessionId: info.id,
				sessionFile: info.path,
				cwd: info.cwd || target,
				name: info.name,
				active: false,
				messageCount: info.messageCount,
				createdAt: info.created.getTime(),
			}));
	}

	async closeSession(sessionId: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		if (!entry) return;
		entry.session.dispose();
		this.gates.get(sessionId)?.dispose();
		this.gates.delete(sessionId);
		this.registry.delete(sessionId);
	}

	async prompt(sessionId: string, text: string): Promise<void> {
		const entry = this.requireSession(sessionId);
		await entry.session.prompt(text);
	}

	async abort(sessionId: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		if (!entry) return;
		await entry.session.abort();
	}

	async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
		const entry = this.requireSession(sessionId);
		const runtime = await this.getModelRuntime();
		const model = runtime.getModel(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await entry.session.setModel(model);
	}

	async setThinkingLevel(sessionId: string, level: string): Promise<void> {
		const entry = this.requireSession(sessionId);
		entry.session.setThinkingLevel(level as ThinkingLevel);
	}

	async compact(sessionId: string): Promise<void> {
		const entry = this.requireSession(sessionId);
		await entry.session.compact();
	}

	async getStats(sessionId: string): Promise<SessionStats> {
		const entry = this.requireSession(sessionId);
		const stats = entry.session.getSessionStats();
		return {
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cost: stats.cost,
		};
	}

	async listModels(): Promise<AvailableModel[]> {
		const runtime = await this.getModelRuntime();
		const available = await runtime.getAvailable();
		return available.map((model) => ({
			provider: model.provider,
			id: model.id,
			label: model.name,
			authed: true,
		}));
	}

	onEvent(handler: EventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	onPermissionRequest(handler: PermissionHandler): () => void {
		this.permissionHandlers.add(handler);
		return () => this.permissionHandlers.delete(handler);
	}

	respondPermission(requestId: string, answer: PermissionAnswer): void {
		for (const gate of this.gates.values()) {
			gate.respond(requestId, answer);
		}
	}

	dispose(): void {
		this.registry.disposeAll();
		this.eventHandlers.clear();
		this.permissionHandlers.clear();
	}

	private requireSession(sessionId: string) {
		const entry = this.registry.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		return entry;
	}

	private toMetaOrThrow(sessionId: string): SessionMeta {
		const entry = this.registry.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		return this.registry.toMeta(entry);
	}

	private dispatchPermissionRequest(req: PermissionRequest): void {
		for (const handler of this.permissionHandlers) {
			try {
				handler(req);
			} catch {
				// 忽略单个处理器异常
			}
		}
	}
}

export type { EventForwarder, Model };
