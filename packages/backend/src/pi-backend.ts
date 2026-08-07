import { unlink } from "node:fs/promises";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	AvailableModel,
	ContextUsageInfo,
	CreateSessionOptions,
	ImageInput,
	PermissionAnswer,
	PermissionRequest,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SessionToolCall,
	SlashCommandInfo,
	TrustAnswer,
	TrustRequest,
} from "@pi-desktop/shared";
import { createLogger } from "./log";
import { PermissionGate } from "./permissions";
import { autoNameSession } from "./session-naming";
import { type EventForwarder, SessionRegistry } from "./session-registry";
import { SettingsService } from "./settings";
import { TraceRecorder } from "./trace";
import { resolveProjectTrust, TrustGate } from "./trust";
import { makeUiContext } from "./ui-context";

const log = createLogger("backend");

export interface PiBackendOptions {
	/** 默认工作目录（createSession 未指定时使用） */
	defaultCwd?: string;
	/** 每会话工具白名单；缺省用 pi 默认（read/bash/edit/write） */
	tools?: string[];
	/** 额外自定义工具 */
	customTools?: ToolDefinition[];
	/** 是否启用权限确认门控（false 时 confirm 直接通过） */
	permissionGates?: boolean;
	/** 是否启用项目信任门控（false 时所有项目自动信任，项目资源直接加载；供无人值守场景用） */
	projectTrust?: boolean;
}

type EventHandler = (sessionId: string, event: AgentSessionEvent) => void;
type PermissionHandler = (req: PermissionRequest) => void;
type TrustHandler = (req: TrustRequest) => void;

/**
 * PiBackend：pi SDK 的唯一适配层。不依赖 Electron，
 * 主进程与（未来的）独立 server 均可复用。
 */
export class PiBackend {
	private readonly registry = new SessionRegistry();
	private readonly eventHandlers = new Set<EventHandler>();
	private readonly permissionHandlers = new Set<PermissionHandler>();
	private readonly trustHandlers = new Set<TrustHandler>();
	private readonly gates = new Map<string, PermissionGate>();
	/** 项目信任决策记录（~/.pi/agent/trust.json，与 CLI 共享）+ 信任请求门控 */
	private readonly trustStore = new ProjectTrustStore(getAgentDir());
	private readonly trustGate = new TrustGate((req) => this.dispatchTrustRequest(req));
	/** 会话事件 trace（JSONL，离线可重放） */
	private readonly traceRecorders = new Map<string, TraceRecorder>();
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
		this.traceRecorders.get(sessionId)?.record(event);
		for (const handler of this.eventHandlers) {
			try {
				handler(sessionId, event);
			} catch {
				// 事件处理器异常不影响主流程
			}
		}
	}

	/** 为会话建立 trace（与会话同目录） */
	private async startTrace(sessionId: string, sessionDir: string | undefined): Promise<void> {
		if (!sessionDir) return;
		try {
			const recorder = await TraceRecorder.create(sessionDir, sessionId);
			this.traceRecorders.set(sessionId, recorder);
		} catch (err) {
			log.warn("trace create failed", sessionId, err);
		}
	}

	/** 停止并落盘 trace */
	private async stopTrace(sessionId: string): Promise<void> {
		const recorder = this.traceRecorders.get(sessionId);
		if (!recorder) return;
		this.traceRecorders.delete(sessionId);
		await recorder.close();
	}

	async init(): Promise<void> {
		await this.getModelRuntime();
	}

	/**
	 * 两阶段加载项目资源（对齐 CLI main.js:533-570）：
	 * 先 projectTrusted=false 只加载用户级资源 → 解析项目信任 → 按结果重载。
	 * 不信任时项目级 settings/extensions/skills/prompts/themes 不加载。
	 */
	private async loadProjectResources(cwd: string): Promise<{
		settingsManager: SettingsManager;
		resourceLoader: DefaultResourceLoader;
	}> {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		if (this.options.projectTrust === false) {
			settingsManager.setProjectTrusted(true);
			await resourceLoader.reload();
			return { settingsManager, resourceLoader };
		}
		await resourceLoader.reload({
			resolveProjectTrust: async () => {
				const trusted = await resolveProjectTrust({
					cwd,
					trustStore: this.trustStore,
					defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
					askUser:
						this.trustHandlers.size > 0 ? (dir, options) => this.trustGate.ask(dir, options) : undefined,
				});
				log.info("project trust resolved", cwd, { trusted });
				return trusted;
			},
		});
		return { settingsManager, resourceLoader };
	}

	async createSession(options: CreateSessionOptions): Promise<SessionMeta> {
		const runtime = await this.getModelRuntime();
		const cwd = options.cwd || this.options.defaultCwd || process.cwd();
		const model =
			options.provider && options.modelId ? runtime.getModel(options.provider, options.modelId) : undefined;

		const gate = new PermissionGate((req) => this.dispatchPermissionRequest(req));

		const { settingsManager, resourceLoader } = await this.loadProjectResources(cwd);
		const { session } = await createAgentSession({
			cwd,
			modelRuntime: runtime,
			model,
			thinkingLevel: options.thinkingLevel as ThinkingLevel | undefined,
			tools: this.options.tools,
			customTools: this.options.customTools,
			sessionManager: SessionManager.create(cwd),
			settingsManager,
			resourceLoader,
		});

		gate.bindSession(session.sessionId);
		this.gates.set(session.sessionId, gate);
		if (this.options.permissionGates !== false) {
			await session.bindExtensions({
				uiContext: makeUiContext(gate),
				mode: "tui",
			});
		}

		const unsubscribe = session.subscribe((event) => {
			autoNameSession(session, event);
			this.emitEvent(session.sessionId, event);
		});
		this.registry.add({ session, unsubscribe, cwd });
		await this.startTrace(session.sessionId, session.sessionManager.getSessionDir());
		log.info("session created", session.sessionId, { cwd });
		return this.toMetaOrThrow(session.sessionId);
	}

	async openSession(filePath: string): Promise<SessionMeta> {
		const runtime = await this.getModelRuntime();
		const sessionManager = SessionManager.open(filePath);
		const cwd = sessionManager.getCwd() || process.cwd();
		const { settingsManager, resourceLoader } = await this.loadProjectResources(cwd);
		const { session } = await createAgentSession({
			sessionManager,
			modelRuntime: runtime,
			settingsManager,
			resourceLoader,
		});
		const unsubscribe = session.subscribe((event) => {
			autoNameSession(session, event);
			this.emitEvent(session.sessionId, event);
		});
		this.registry.add({ session, unsubscribe, cwd });
		await this.startTrace(session.sessionId, session.sessionManager.getSessionDir());
		log.info("session opened", session.sessionId, { file: filePath });
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
				modifiedAt: info.modified.getTime(),
			}));
	}

	/** 跨全部项目目录枚举会话（项目管理页用，含活跃会话） */
	async listAllSessions(): Promise<SessionMeta[]> {
		const infos = await SessionManager.listAll();
		const activeIds = new Set(this.registry.list().map((e) => e.session.sessionId));
		return infos
			.filter((info) => info.cwd)
			.map((info) => ({
				sessionId: info.id,
				sessionFile: info.path,
				cwd: info.cwd || "",
				name: info.name,
				active: activeIds.has(info.id),
				messageCount: info.messageCount,
				createdAt: info.created.getTime(),
				modifiedAt: info.modified.getTime(),
			}));
	}

	async closeSession(sessionId: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		if (!entry) return;
		entry.session.dispose();
		this.gates.get(sessionId)?.dispose();
		this.gates.delete(sessionId);
		this.registry.delete(sessionId);
		await this.stopTrace(sessionId);
		log.info("session closed", sessionId);
	}

	/** 删除历史会话（pi 无删除 API，会话即磁盘 jsonl，直接删文件） */
	async deleteSession(sessionId: string, sessionFile?: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		const sessionDir = entry?.session.sessionManager.getSessionDir();
		const file = sessionFile ?? entry?.session.sessionManager.getSessionFile();
		if (entry) await this.closeSession(sessionId);
		if (!file) throw new Error(`Session file not found: ${sessionId}`);
		await unlink(file);
		if (sessionDir) await TraceRecorder.removeAll(sessionDir, sessionId);
		log.info("session deleted", sessionId);
	}

	async prompt(sessionId: string, text: string, images?: ImageInput[]): Promise<void> {
		const entry = this.requireSession(sessionId);
		log.info("prompt", sessionId, { text: text.slice(0, 120), images: images?.length ?? 0 });
		await entry.session.prompt(text, {
			images: images?.map((image) => ({
				type: "image" as const,
				data: image.data,
				mimeType: image.mimeType,
			})),
		});
	}

	async abort(sessionId: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		if (!entry) return;
		log.info("abort", sessionId);
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
		log.info("compact", sessionId);
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

	/** 当前模型上下文使用情况；刚压缩后 tokens 未知（null），会话无模型时 percent 为 null */
	async getContextUsage(sessionId: string): Promise<ContextUsageInfo | null> {
		const entry = this.requireSession(sessionId);
		const usage = entry.session.getContextUsage();
		if (!usage) return null;
		return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
	}

	/** 列出斜杠命令：内置（标记 supported）+ prompt 模板 + skill + 扩展命令 */
	async listSlashCommands(sessionId: string): Promise<SlashCommandInfo[]> {
		const entry = this.requireSession(sessionId);
		const session = entry.session;
		const templates: SlashCommandInfo[] = session.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
			argumentHint: template.argumentHint,
			source: "template",
			supported: true,
		}));
		const skills: SlashCommandInfo[] = session.resourceLoader.getSkills().skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			supported: true,
		}));
		const extensions: SlashCommandInfo[] = session.extensionRunner.getRegisteredCommands().map((command) => ({
			name: command.invocationName,
			description: command.description ?? "",
			source: "extension",
			supported: true,
		}));
		return [...BUILTIN_SLASH_COMMANDS, ...templates, ...skills, ...extensions];
	}

	/** 设置会话显示名（触发 session_info_changed 事件） */
	async setSessionName(sessionId: string, name: string): Promise<void> {
		const entry = this.requireSession(sessionId);
		entry.session.setSessionName(name);
	}

	/** 导出会话内容（HTML/JSONL）；返回文件内容，由调用方保存 */
	async exportSession(sessionId: string, format: "html" | "jsonl"): Promise<string> {
		const entry = this.requireSession(sessionId);
		return format === "html" ? entry.session.exportToHtml() : entry.session.exportToJsonl();
	}

	/** 读取会话历史消息（打开历史会话时回放给 UI） */
	async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
		const entry = this.requireSession(sessionId);
		return toSessionMessages(entry.session.messages);
	}

	async listModels(): Promise<AvailableModel[]> {
		const providers = await this.settings.listProviders();
		return providers.flatMap((provider) =>
			provider.configured
				? provider.models.map((model) => ({
						provider: provider.id,
						providerName: provider.name,
						id: model.id,
						label: model.name,
						authed: true,
					}))
				: [],
		);
	}

	onEvent(handler: EventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	onPermissionRequest(handler: PermissionHandler): () => void {
		this.permissionHandlers.add(handler);
		return () => this.permissionHandlers.delete(handler);
	}

	onTrustRequest(handler: TrustHandler): () => void {
		this.trustHandlers.add(handler);
		return () => this.trustHandlers.delete(handler);
	}

	respondPermission(requestId: string, answer: PermissionAnswer): void {
		for (const gate of this.gates.values()) {
			gate.respond(requestId, answer);
		}
	}

	respondTrust(requestId: string, answer: TrustAnswer): void {
		this.trustGate.respond(requestId, answer);
	}

	dispose(): void {
		this.registry.disposeAll();
		this.eventHandlers.clear();
		this.permissionHandlers.clear();
		this.trustHandlers.clear();
		this.trustGate.dispose();
		for (const recorder of this.traceRecorders.values()) {
			void recorder.close();
		}
		this.traceRecorders.clear();
		log.info("backend disposed");
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

	private dispatchTrustRequest(req: TrustRequest): void {
		for (const handler of this.trustHandlers) {
			try {
				handler(req);
			} catch {
				// 忽略单个处理器异常
			}
		}
	}
}

export type { EventForwarder, Model };

/**
 * pi 内置斜杠命令表（与 pi 0.84.0 的 BUILTIN_SLASH_COMMANDS 对齐）。
 * supported=false 表示桌面端尚未实现，面板中置灰展示。
 * 注：模板/skill/扩展命令不由这里列出，SDK prompt() 原生处理。
 */
const BUILTIN_SLASH_COMMANDS: SlashCommandInfo[] = [
	{ name: "compact", description: "Compress session context", source: "builtin", supported: true },
	{
		name: "name",
		description: "Set session display name",
		argumentHint: "<name>",
		source: "builtin",
		supported: true,
	},
	{ name: "copy", description: "Copy last agent message to clipboard", source: "builtin", supported: true },
	{
		name: "export",
		description: "Export session (.html/.jsonl)",
		argumentHint: "[path]",
		source: "builtin",
		supported: true,
	},
	{ name: "new", description: "Start a new session", source: "builtin", supported: true },
	{ name: "settings", description: "Open settings", source: "builtin", supported: true },
	{
		name: "login",
		description: "Configure provider authentication",
		argumentHint: "<provider>",
		source: "builtin",
		supported: true,
	},
	{
		name: "model",
		description: "Select model",
		argumentHint: "<provider/model>",
		source: "builtin",
		supported: false,
	},
	{
		name: "scoped-models",
		description: "Manage models for Ctrl+P cycling",
		source: "builtin",
		supported: false,
	},
	{ name: "session", description: "Show session info and stats", source: "builtin", supported: false },
	{
		name: "import",
		description: "Import and resume a session from JSONL",
		source: "builtin",
		supported: false,
	},
	{ name: "share", description: "Share session as secret gist", source: "builtin", supported: false },
	{
		name: "fork",
		description: "Create a fork from a previous user message",
		source: "builtin",
		supported: false,
	},
	{ name: "clone", description: "Duplicate the current session", source: "builtin", supported: false },
	{ name: "tree", description: "Navigate session tree", source: "builtin", supported: false },
	{ name: "resume", description: "Resume a different session", source: "builtin", supported: false },
	{ name: "trust", description: "Save project trust decision", source: "builtin", supported: false },
	{ name: "logout", description: "Remove provider authentication", source: "builtin", supported: false },
	{ name: "reload", description: "Reload extensions, skills, prompts", source: "builtin", supported: false },
	{ name: "changelog", description: "Show changelog entries", source: "builtin", supported: false },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin", supported: false },
	{ name: "quit", description: "Quit pi", source: "builtin", supported: false },
];

/** 消息 content 块（pi-ai 结构，仅读取所需字段） */
interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	data?: string;
	mimeType?: string;
}

interface RawMessage {
	role: string;
	content?: string | ContentBlock[];
	toolCallId?: string;
	isError?: boolean;
	timestamp?: number;
}

function blockText(content: string | ContentBlock[] | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text ?? "")
		.join("");
}

function blockThinking(content: ContentBlock[] | undefined): string {
	return (content ?? [])
		.filter((c) => c.type === "thinking" && c.thinking)
		.map((c) => c.thinking ?? "")
		.join("");
}

function blockToolCalls(content: ContentBlock[] | undefined): SessionToolCall[] {
	return (content ?? [])
		.filter((c) => c.type === "toolCall" && c.id)
		.map((c) => ({
			id: c.id ?? "",
			name: c.name ?? "tool",
			args: JSON.stringify(c.arguments ?? {}),
			output: "",
			isError: false,
		}));
}

function blockImages(content: string | ContentBlock[] | undefined): ImageInput[] {
	if (typeof content === "string") return [];
	return (content ?? [])
		.filter((c) => c.type === "image" && c.data)
		.map((c) => ({ data: c.data as string, mimeType: (c.mimeType as string) ?? "image/png" }));
}

/**
 * pi 消息 → 中立 SessionMessage 列表。
 * toolResult 消息单独出现（带 toolCallId），把输出回填到对应工具卡片。
 */
export function toSessionMessages(rawMessages: readonly unknown[]): SessionMessage[] {
	const out: SessionMessage[] = [];
	const toolById = new Map<string, SessionToolCall>();
	for (const raw of rawMessages as RawMessage[]) {
		if (raw.role === "user") {
			out.push({
				role: "user",
				text: blockText(raw.content),
				thinking: "",
				tools: [],
				images: blockImages(raw.content),
				timestamp: raw.timestamp ?? Date.now(),
			});
			continue;
		}
		if (raw.role === "assistant") {
			const content = Array.isArray(raw.content) ? raw.content : [];
			const tools = blockToolCalls(content);
			for (const tool of tools) toolById.set(tool.id, tool);
			const message: SessionMessage = {
				role: "assistant",
				text: blockText(raw.content),
				thinking: blockThinking(content),
				tools,
				images: [],
				timestamp: raw.timestamp ?? Date.now(),
			};
			if (message.text || message.thinking || message.tools.length > 0) {
				out.push(message);
			}
			continue;
		}
		if (raw.role === "toolResult") {
			const tool = raw.toolCallId ? toolById.get(raw.toolCallId) : undefined;
			if (tool) {
				tool.output = blockText(raw.content);
				tool.isError = raw.isError === true;
			}
		}
	}
	return out;
}
