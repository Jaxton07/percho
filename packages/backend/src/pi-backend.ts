import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultPackageManager,
	DefaultResourceLoader,
	type Extension,
	getAgentDir,
	ModelRuntime,
	ProjectTrustStore,
	type ResourceLoader,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	AvailableModel,
	CatalogPackageType,
	CatalogSearchResult,
	ConfiguredPackageInfo,
	ContextUsageInfo,
	CreateSessionOptions,
	ImageInput,
	LoadedResources,
	PermissionAnswer,
	PermissionRequest,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SessionToolCall,
	SlashCommandInfo,
	TrustAnswer,
	TrustRequest,
	VisionConfigInfo,
	VisionSaveInput,
	VisionTestResult,
} from "@percho/shared";
import {
	DEFAULT_VISION_BASE_URL,
	DEFAULT_VISION_MODEL,
	extractSubagentRuns,
	extractTodos,
	TODO_REMINDER_CUSTOM_TYPE,
	TODO_TOOL_NAME,
	type TodoItem,
} from "@percho/shared";
import { createLogger } from "./log";
import { fetchPackageCatalog } from "./package-catalog";
import { makePermissionGateExtension } from "./permission-extension";
import { loadPermissionConfig, setPermissionEnabled as writePermissionEnabled } from "./permission-rules";
import { PermissionGate } from "./permissions";
import { walkProjectFiles } from "./project-files";
import { autoNameSession } from "./session-naming";
import { type EventForwarder, SessionRegistry } from "./session-registry";
import { SettingsService } from "./settings";
import { makeShowImageTool } from "./show-image-tool";
import { makeTodoReminderExtension } from "./todo-reminder-extension";
import { makeTodoTool } from "./todo-tool";
import { TraceRecorder } from "./trace";
import { resolveProjectTrust, TrustGate } from "./trust";
import { makeUiContext } from "./ui-context";
import { pingVision } from "./vision-client";
import { resolveVisionKey, VisionConfigService } from "./vision-config";
import { makeVisionProxyExtension } from "./vision-proxy-extension";
import { makeWebFetchTool } from "./webfetch";

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
	/** 是否注册内置权限门控扩展（false 时逐工具规则不生效；用户换用自己的权限扩展时关闭）。permissionGates=false 时强制不注册 */
	permissionExtension?: boolean;
	/** 是否启用项目信任门控（false 时所有项目自动信任，项目资源直接加载；供无人值守场景用） */
	projectTrust?: boolean;
	/** 是否内置 webfetch 工具（默认 true）；传对象可配置 CIDR 放行 */
	webFetch?: boolean | { allowRanges?: string[] };
	/** 视觉代理配置文件路径（userData/vision.json）；缺省不启用视觉代理功能 */
	visionConfigPath?: string;
	/** 是否注册内置视觉代理扩展（默认 true；visionConfigPath 缺省时无效果） */
	visionProxy?: boolean;
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
	/** 视觉代理配置（userData/vision.json；未提供路径时禁用） */
	private readonly visionConfig: VisionConfigService | undefined;

	constructor(private readonly options: PiBackendOptions = {}) {
		this.visionConfig = options.visionConfigPath
			? new VisionConfigService(options.visionConfigPath)
			: undefined;
	}

	/** 自定义工具 = 调用方传入的 + 内置 webfetch（webFetch:false 关闭）+ show_image + todo */
	private buildCustomTools(): ToolDefinition[] {
		const tools = [...(this.options.customTools ?? [])];
		const webFetch = this.options.webFetch;
		if (webFetch !== false) {
			tools.push(makeWebFetchTool(typeof webFetch === "object" ? webFetch : undefined));
		}
		tools.push(makeShowImageTool());
		tools.push(makeTodoTool());
		return tools;
	}

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

	/** 项目文件列表（@ 补全数据源，相对路径、目录带尾 /，TTL 缓存） */
	async listProjectFiles(cwd?: string): Promise<string[]> {
		return walkProjectFiles(cwd || this.options.defaultCwd || process.cwd());
	}

	/**
	 * 两阶段加载项目资源（对齐 CLI main.js:533-570）：
	 * 先 projectTrusted=false 只加载用户级资源 → 解析项目信任 → 按结果重载。
	 * 不信任时项目级 settings/extensions/skills/prompts/themes 不加载。
	 * askTrust=false 时信任未决按不信任处理（不弹窗）：draft 拉斜杠命令等只读场景用，
	 * 弹窗已在选目录时经 ensureProjectTrust 前置。
	 */
	private async loadProjectResources(
		cwd: string,
		options?: { askTrust?: boolean },
	): Promise<{
		settingsManager: SettingsManager;
		resourceLoader: DefaultResourceLoader;
	}> {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		// 内置扩展随资源加载器注册（inline factory，不受项目信任影响）：todo-reminder
		// 负责 compaction 后恢复任务列表（不受权限开关影响）；权限门控扩展受
		// permissionGates/permissionExtension 开关控制（permissionGates=false 时
		// confirm 恒 false，不能注册）
		const extensionFactories = [makeTodoReminderExtension()];
		if (this.options.permissionGates !== false && this.options.permissionExtension !== false) {
			extensionFactories.push(makePermissionGateExtension(agentDir, { projectRoot: cwd }));
		}
		// 视觉代理：每次 LLM 调用前把 image block 换成识别描述（纯文本模型用）。
		// handler 内实时读配置，设置页保存后对所有已打开会话立即生效
		if (this.visionConfig && this.options.visionProxy !== false) {
			extensionFactories.push(makeVisionProxyExtension({ configService: this.visionConfig }));
		}
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories,
		});
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
						options?.askTrust !== false && this.trustHandlers.size > 0
							? (dir, opts) => this.trustGate.ask(dir, opts)
							: undefined,
				});
				log.info("project trust resolved", cwd, { trusted });
				return trusted;
			},
		});
		return { settingsManager, resourceLoader };
	}

	/**
	 * 项目信任前置决策（添加项目/切换 draft cwd 时由 renderer 调用）：未决则经
	 * TrustGate 弹窗，结果落 trust.json；此后 draft 拉命令与建会话都命中缓存，不再弹窗。
	 */
	async ensureProjectTrust(cwd: string): Promise<boolean> {
		const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore: this.trustStore,
			defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
			askUser: this.trustHandlers.size > 0 ? (dir, o) => this.trustGate.ask(dir, o) : undefined,
		});
		log.info("project trust ensured", cwd, { trusted });
		return trusted;
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
			customTools: this.buildCustomTools(),
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
			customTools: this.buildCustomTools(),
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
		// session.prompt() 非流式路径会 await 整个 run（直到 agent_settled）；渲染端只需要
		// “已受理/已入队”回执——用 preflightResult 提前返回，否则 IPC 挂一整轮，渲染端
		// sending 状态被占住，运行中的 followUp 排队发送被防重发守卫静默拦截。
		// preflight 前抛错（无模型/无 key/compaction 中）照常 reject 传给渲染端；
		// ack 之后 run 期错误不再回传（走事件流呈现），then 的 reject 在已 resolve 后为 no-op。
		// preflightResult(false) 只在 SDK catch 里紧随 throw 触发，不据此 reject，真实错误经 throw 传递。
		await new Promise<void>((resolve, reject) => {
			entry.session
				.prompt(text, {
					// 运行中发送走 followUp 排队（agent 完成后自动投递；steer 打断暂不支持）
					// SDK 要求 streaming 时必传 streamingBehavior，否则抛错
					streamingBehavior: "followUp",
					images: images?.map((image) => ({
						type: "image" as const,
						data: image.data,
						mimeType: image.mimeType,
					})),
					preflightResult: (ok) => {
						if (ok) resolve();
					},
				})
				.then(
					() => resolve(),
					(err) => reject(err),
				);
		});
	}

	async abort(sessionId: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		if (!entry) return;
		log.info("abort", sessionId);
		await entry.session.abort();
	}

	/** 清空运行中排队消息（steer+followUp 都清），返回被清内容；无会话返回空 */
	async clearQueue(sessionId: string): Promise<{ steering: string[]; followUp: string[] }> {
		const entry = this.registry.get(sessionId);
		if (!entry) return { steering: [], followUp: [] };
		log.info("clearQueue", sessionId);
		return entry.session.clearQueue();
	}

	/** 当前排队的 followUp 消息文本；无会话返回空 */
	async getFollowUpMessages(sessionId: string): Promise<string[]> {
		const entry = this.registry.get(sessionId);
		if (!entry) return [];
		return [...entry.session.getFollowUpMessages()];
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

	async compact(sessionId: string, customInstructions?: string): Promise<void> {
		const entry = this.requireSession(sessionId);
		log.info("compact", sessionId);
		await entry.session.compact(customInstructions);
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
		// 扩展命令走 runner（反映 bindExtensions 后的运行时注册与重名去重）
		const extensions: SlashCommandInfo[] = session.extensionRunner.getRegisteredCommands().map((command) => ({
			name: command.invocationName,
			description: command.description ?? "",
			source: "extension",
			supported: true,
		}));
		return [
			...BUILTIN_SLASH_COMMANDS,
			...templateCommands(session.resourceLoader),
			...skillCommands(session.resourceLoader),
			...extensions,
		];
	}

	/**
	 * 无会话列出斜杠命令（draft 新会话的补全数据源）：三类命令都只依赖
	 * DefaultResourceLoader（扩展命令在加载期注册进 ext.commands），无需建会话。
	 * 信任未决的项目不弹窗、按不信任只加载用户级资源（弹窗已在选目录时前置）。
	 */
	async listSlashCommandsForCwd(cwd?: string): Promise<SlashCommandInfo[]> {
		const target = cwd || this.options.defaultCwd || process.cwd();
		const { resourceLoader } = await this.loadProjectResources(target, { askTrust: false });
		return [
			...BUILTIN_SLASH_COMMANDS,
			...templateCommands(resourceLoader),
			...skillCommands(resourceLoader),
			...extensionCommands(resourceLoader.getExtensions().extensions),
		];
	}

	/** 扩展显示名：`<inline:N>` 原样，目录式扩展取最后一段（剥 index.ts 后缀） */
	private extensionDisplayName(path: string): string {
		const cleaned = path.replace(/\/index\.(ts|js)$/, "");
		const base = cleaned.split("/").filter(Boolean).pop();
		return base ?? path;
	}

	/** 读取会话已加载的资源（skills/扩展；设置页展示用） */
	async getLoadedResources(sessionId: string): Promise<LoadedResources> {
		const entry = this.requireSession(sessionId);
		const session = entry.session;
		const skillResult = session.resourceLoader.getSkills();
		const extResult = session.resourceLoader.getExtensions();
		return {
			skills: skillResult.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				scope: skill.sourceInfo.scope,
				source: skill.sourceInfo.source,
				path: skill.filePath,
				disableModelInvocation: skill.disableModelInvocation,
			})),
			skillDiagnostics: skillResult.diagnostics.map((d) => ({
				type: d.type,
				message: d.message,
				path: d.path,
			})),
			extensions: extResult.extensions.map((ext) => ({
				name: this.extensionDisplayName(ext.path),
				path: ext.path,
				scope: ext.sourceInfo.scope,
				source: ext.sourceInfo.source,
				hidden: ext.hidden === true,
				toolsCount: ext.tools.size,
				commands: [...ext.commands.keys()],
				flagsCount: ext.flags.size,
				shortcutsCount: ext.shortcuts.size,
			})),
			extensionErrors: extResult.errors,
		};
	}

	/** 包管理器（用户级安装/卸载，懒加载；settingsManager 仅用于读写 settings.json 安装记录） */
	private packageManager: DefaultPackageManager | undefined;
	private getPackageManager(): DefaultPackageManager {
		if (!this.packageManager) {
			const cwd = this.options.defaultCwd || process.cwd();
			this.packageManager = new DefaultPackageManager({
				cwd,
				agentDir: getAgentDir(),
				settingsManager: SettingsManager.create(cwd, getAgentDir()),
			});
		}
		return this.packageManager;
	}

	/** 搜索 pi.dev 社区包目录（设置页扩展面板浏览用） */
	async searchPackages(
		query: string,
		type?: CatalogPackageType | "",
		page?: number,
	): Promise<CatalogSearchResult> {
		return fetchPackageCatalog({ query, type: type || undefined, page });
	}

	/** 列出 settings.json 已配置的包（「已安装」态匹配用） */
	async listConfiguredPackages(): Promise<ConfiguredPackageInfo[]> {
		return this.getPackageManager()
			.listConfiguredPackages()
			.map((p) => ({ source: p.source, scope: p.scope }));
	}

	/** 安装社区包（npm:<name>，用户级）；成功后热重载非流式活跃会话，扩展立即生效（对齐 CLI /reload） */
	async installPackage(name: string): Promise<void> {
		if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
			throw new Error(`Invalid package name: ${name}`);
		}
		await this.getPackageManager().installAndPersist(`npm:${name}`);
		log.info("package installed", name);
		await this.reloadSessions();
	}

	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后热重载非流式活跃会话 */
	async removePackage(source: string, scope: "user" | "project"): Promise<void> {
		const removed = await this.getPackageManager().removeAndPersist(source, {
			local: scope === "project",
		});
		if (!removed) throw new Error(`Package not installed: ${source}`);
		log.info("package removed", source, { scope });
		await this.reloadSessions();
	}

	/** 对非流式活跃会话做资源热重载（装/卸包后立即生效） */
	private async reloadSessions(): Promise<void> {
		for (const entry of this.registry.list()) {
			if (entry.session.isStreaming) {
				log.info("skip reload while streaming", entry.session.sessionId);
				continue;
			}
			try {
				await entry.session.reload();
			} catch (err) {
				log.warn("session reload failed", entry.session.sessionId, err);
			}
		}
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
		const messages = toSessionMessages(entry.session.messages);
		// 配对消息与会话树 entry id（assistant 供 fork 定位、user 供撤回定位）：branch 上
		// 同角色消息 entry 按 timestamp 建队列，与上下文消息同序消费；compaction 只截断更早
		// entry，不影响配对。user/assistant 分开建表，避免同 ms 碰撞时串角色
		const assistantByTimestamp = new Map<number, string[]>();
		const userByTimestamp = new Map<number, string[]>();
		for (const e of entry.session.sessionManager.getBranch()) {
			if (e.type !== "message") continue;
			const m = e.message as RawMessage;
			if (typeof m.timestamp !== "number") continue;
			const table =
				m.role === "assistant" ? assistantByTimestamp : m.role === "user" ? userByTimestamp : null;
			if (!table) continue;
			const queue = table.get(m.timestamp);
			if (queue) queue.push(e.id);
			else table.set(m.timestamp, [e.id]);
		}
		for (const message of messages) {
			// 无正文的拆分消息（同 turn 正文后的工具组）不参与配对：无 fork 按钮不消费 entry 队列，
			// 避免挤占后续正文消息的 entryId（同 ms timestamp 碰撞时）
			if (message.role === "assistant") {
				if (!message.text) continue;
				const id = assistantByTimestamp.get(message.timestamp)?.shift();
				if (id) message.entryId = id;
				continue;
			}
			if (message.role === "user") {
				const id = userByTimestamp.get(message.timestamp)?.shift();
				if (id) message.entryId = id;
			}
		}
		return messages;
	}

	/**
	 * 读取会话当前 todo 列表：扫 session.messages（裁剪后的上下文）找最后一条
	 * todo 工具结果的 details，或最后一条 todo-reminder custom message 的 details
	 * （compaction 后注入的恢复消息；toolResult 已被截断时兜底）。都没有返回 []。
	 */
	async getTodos(sessionId: string): Promise<TodoItem[]> {
		const entry = this.requireSession(sessionId);
		for (const raw of [...entry.session.messages].reverse()) {
			const m = raw as RawMessage;
			if (m.role === "toolResult" && m.toolName === TODO_TOOL_NAME && !m.isError) {
				const todos = extractTodos(m.details);
				if (todos) return todos;
			}
			if (m.role === "custom" && m.customType === TODO_REMINDER_CUSTOM_TYPE) {
				const todos = extractTodos(m.details);
				if (todos) return todos;
			}
		}
		return [];
	}

	/**
	 * 在指定 assistant 消息处分叉：新会话文件以其为结尾（原文件与原会话都保留），
	 * 打开新会话并返回其 meta（调用方决定新开会话标签还是原位切换）。
	 * ref.entryId 精确定位；缺省时按 ref.text 从分支尾部向前匹配最近一条同文 assistant 消息
	 * （刚完成的流式消息还没有 entryId，走文本兜底）。
	 */
	async forkSession(sessionId: string, ref: { entryId?: string; text?: string }): Promise<SessionMeta> {
		const entry = this.requireSession(sessionId);
		if (entry.session.isStreaming) throw new Error("Cannot fork while the agent is running");
		const sourceManager = entry.session.sessionManager;
		const targetId = this.resolveForkEntryId(sourceManager, ref);
		const file = sourceManager.getSessionFile();
		if (!file || !existsSync(file)) {
			throw new Error("This session has not been saved yet. Send a message first.");
		}
		// 在新打开的 manager 上分叉，避免动当前会话的 manager 状态
		const forkedManager = SessionManager.open(file, sourceManager.getSessionDir());
		const newPath = forkedManager.createBranchedSession(targetId);
		if (!newPath) throw new Error("Failed to create forked session");
		log.info("fork session", sessionId, { targetId, newPath });
		return this.openSession(newPath);
	}

	/** 解析 fork 目标 entry：entryId 直接校验；否则按正文文本从分支尾部向前匹配 assistant 消息 */
	private resolveForkEntryId(sm: SessionManager, ref: { entryId?: string; text?: string }): string {
		if (ref.entryId && sm.getEntry(ref.entryId)) return ref.entryId;
		if (ref.text) {
			const branch = sm.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e?.type !== "message") continue;
				const m = e.message as RawMessage;
				if (m.role !== "assistant") continue;
				if (blockText(m.content) === ref.text) return e.id;
			}
		}
		throw new Error("Fork target message not found");
	}

	/** 撤回的 custom entry 标记类型：追加在回退点后使 leaf 移动落盘持久（重启后撤回仍生效） */
	static readonly RECALLED_MARKER_TYPE = "message-recalled";

	/**
	 * 撤回一条用户消息：navigateTree 把会话 leaf 回退到该消息之前（被撤回内容在文件中
	 * 保留为侧枝，不删除），同时重建内存 LLM 上下文；随后追加 message-recalled custom entry
	 * （不进上下文、不进消息列表）把 leaf 移动持久化，避免重启后旧分支回来。
	 * 文本与图片从目标 entry 提取后返回，调用方放回输入框继续编辑。
	 */
	async recallMessage(
		sessionId: string,
		ref: { entryId?: string; text?: string; timestamp?: number },
	): Promise<{ text: string; images: ImageInput[] }> {
		const entry = this.requireSession(sessionId);
		if (entry.session.isStreaming) throw new Error("Cannot recall while the agent is running");
		const sm = entry.session.sessionManager;
		const targetId = resolveRecallEntryId(sm, ref);
		const target = sm.getEntry(targetId) as Extract<SessionEntry, { type: "message" }>;
		const message = target.message as RawMessage;
		// 文本/图片从目标 entry 提取（navigateTree 只返回 editorText，图片会丢）
		const text = blockText(message.content);
		const images = blockImages(message.content);
		if (sm.getLeafId() === targetId) {
			// 悬挂的用户消息（发出后无任何回复，entry 即当前 leaf）：navigateTree 视为 no-op，
			// 手动回退 leaf 并同步内存上下文（与 navigateTree 内部做的事一致）
			if (target.parentId) sm.branch(target.parentId);
			else sm.resetLeaf();
			entry.session.agent.state.messages = sm.buildSessionContext().messages;
		} else {
			const result = await entry.session.navigateTree(targetId);
			if (result.cancelled) throw new Error("Recall was cancelled by an extension");
		}
		// 持久化回退点：custom entry 不参与 LLM 上下文，只把 leaf 移动写进文件
		// （否则撤回只存在内存，重启后旧分支回来）
		sm.appendCustomEntry(PiBackend.RECALLED_MARKER_TYPE, { recalledEntryId: targetId });
		log.info("recall message", sessionId, { targetId });
		return { text, images };
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

	/** 权限门控配置（设置 UI 开关用；规则全文在 ~/.pi/agent/permissions.json） */
	getPermissionConfig(): { enabled: boolean } {
		return { enabled: loadPermissionConfig(getAgentDir()).enabled };
	}

	/** 写 enabled 开关；扩展按 mtime 重读配置，即时生效 */
	setPermissionEnabled(enabled: boolean): void {
		writePermissionEnabled(getAgentDir(), enabled);
		log.info("permission gate enabled", enabled);
	}

	/** 视觉代理配置（key 只给存在性，不回传）；未提供配置路径时返回禁用态 */
	async getVisionConfig(): Promise<VisionConfigInfo> {
		if (!this.visionConfig) {
			return {
				enabled: false,
				hasKey: false,
				baseUrl: DEFAULT_VISION_BASE_URL,
				model: DEFAULT_VISION_MODEL,
				language: "zh",
			};
		}
		return this.visionConfig.getInfo();
	}

	/** 保存视觉代理配置（即时生效：扩展 handler 每次调用实时读） */
	async saveVisionConfig(input: VisionSaveInput): Promise<VisionConfigInfo> {
		if (!this.visionConfig) return this.getVisionConfig();
		const info = await this.visionConfig.save(input);
		log.info("vision config saved", { enabled: info.enabled, hasKey: info.hasKey, model: info.model });
		return info;
	}

	/** 连通性测试：1×1 png 实调视觉模型（不看 enabled 开关，配置中即可测） */
	async testVision(): Promise<VisionTestResult> {
		if (!this.visionConfig) return { ok: false, message: "vision config unavailable" };
		const config = await this.visionConfig.getConfig();
		if (!resolveVisionKey(config.apiKey)) return { ok: false, message: "API key not configured" };
		try {
			const reply = await pingVision({ config, language: this.visionConfig.getLanguage() });
			return { ok: true, message: reply.slice(0, 200) };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	/** 推送界面语言（识别描述语言跟随；内存态，App 启动/切语言时推送） */
	setVisionLanguage(language: "zh" | "en"): void {
		this.visionConfig?.setLanguage(language);
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
 * pi 内置斜杠命令表（桌面端只保留有实际用途的；TUI 专属/已有 UI 等价物的不列出）。
 * 注：模板/skill/扩展命令不由这里列出，SDK prompt() 原生处理。
 */
const BUILTIN_SLASH_COMMANDS: SlashCommandInfo[] = [
	{
		name: "compact",
		description: "Compress session context",
		argumentHint: "[focus]",
		source: "builtin",
		supported: true,
	},
	{
		name: "name",
		description: "Set session display name",
		argumentHint: "<name>",
		source: "builtin",
		supported: true,
	},
	{
		name: "export",
		description: "Export session (.html/.jsonl)",
		argumentHint: "[path]",
		source: "builtin",
		supported: true,
	},
	{
		name: "settings",
		description: "Open settings",
		source: "builtin",
		supported: true,
	},
];

/** 模板命令映射（listSlashCommands / listSlashCommandsForCwd 共用） */
function templateCommands(loader: ResourceLoader): SlashCommandInfo[] {
	return loader.getPrompts().prompts.map((template) => ({
		name: template.name,
		description: template.description,
		argumentHint: template.argumentHint,
		source: "template",
		supported: true,
	}));
}

/** skill 命令映射（listSlashCommands / listSlashCommandsForCwd 共用） */
function skillCommands(loader: ResourceLoader): SlashCommandInfo[] {
	return loader.getSkills().skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		supported: true,
	}));
}

/**
 * 无会话扩展命令清单（draft 用）：命令在扩展加载期就注册进 ext.commands
 * （注册类扩展 API 无需 bindExtensions），重名命令复刻 SDK
 * ExtensionRunner.resolveRegisteredCommands 的 :N 后缀去重规则。
 */
function extensionCommands(extensions: Extension[]): SlashCommandInfo[] {
	const all = extensions.flatMap((ext) => [...ext.commands.values()]);
	const counts = new Map<string, number>();
	for (const command of all) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
	const seen = new Map<string, number>();
	const taken = new Set<string>();
	return all.map((command) => {
		const occurrence = (seen.get(command.name) ?? 0) + 1;
		seen.set(command.name, occurrence);
		let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
		if (taken.has(invocationName)) {
			let suffix = occurrence;
			do {
				suffix++;
				invocationName = `${command.name}:${suffix}`;
			} while (taken.has(invocationName));
		}
		taken.add(invocationName);
		return {
			name: invocationName,
			description: command.description ?? "",
			source: "extension",
			supported: true,
		};
	});
}

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
	/** 工具结果结构化详情（show_image 在此带图片；模型不可见） */
	details?: unknown;
	/** toolResult 消息的工具名（getTodos 扫 todo 结果用） */
	toolName?: string;
	/** custom 消息的自定义类型（getTodos 扫 todo-reminder 恢复消息用） */
	customType?: string;
}

/** show_image toolResult.details → { images, paths }（兼容旧单图 { path, image } 形状；不符返回 null） */
function showImageFromDetails(details: unknown): { images: ImageInput[]; paths: string[] } | null {
	const d = details as { paths?: unknown; images?: unknown; path?: unknown; image?: unknown } | undefined;
	const toImage = (raw: unknown): ImageInput | null => {
		const img = raw as { data?: unknown; mimeType?: unknown } | undefined;
		if (typeof img?.data !== "string" || typeof img?.mimeType !== "string") return null;
		return { data: img.data, mimeType: img.mimeType };
	};
	if (Array.isArray(d?.images)) {
		const images = d.images.map(toImage).filter((img): img is ImageInput => img !== null);
		if (images.length === 0) return null;
		const paths = Array.isArray(d?.paths) ? d.paths.filter((p): p is string => typeof p === "string") : [];
		return { images, paths };
	}
	const legacy = toImage(d?.image);
	if (!legacy) return null;
	return { images: [legacy], paths: typeof d?.path === "string" ? [d.path] : [] };
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

function blockToolCalls(
	content: ContentBlock[] | undefined,
): Array<{ tool: SessionToolCall; index: number }> {
	return (content ?? [])
		.map((c, index) => ({ c, index }))
		.filter(({ c }) => c.type === "toolCall" && c.id)
		.map(({ c, index }) => ({
			tool: {
				id: c.id ?? "",
				name: c.name ?? "tool",
				args: JSON.stringify(c.arguments ?? {}),
				output: "",
				isError: false,
			},
			index,
		}));
}

function blockImages(content: string | ContentBlock[] | undefined): ImageInput[] {
	if (typeof content === "string") return [];
	return (content ?? [])
		.filter((c) => c.type === "image" && c.data)
		.map((c) => ({ data: c.data as string, mimeType: (c.mimeType as string) ?? "image/png" }));
}

/**
 * 解析撤回目标 user entry：entryId 直接校验（非 user 消息拒绝）；否则按 text（+timestamp
 * 优先比对）从分支尾部向前匹配最近一条 user 消息 entry（实时消息无 entryId 时兜底）。
 * 导出供单测：只依赖 SessionManager 的只读接口。
 */
export function resolveRecallEntryId(
	sm: Pick<SessionManager, "getEntry" | "getBranch">,
	ref: { entryId?: string; text?: string; timestamp?: number },
): string {
	if (ref.entryId) {
		const e = sm.getEntry(ref.entryId);
		if (!e) throw new Error("Recall target message not found");
		if (e.type !== "message" || (e.message as RawMessage).role !== "user") {
			throw new Error("Recall target is not a user message");
		}
		return ref.entryId;
	}
	if (ref.text !== undefined || ref.timestamp !== undefined) {
		const branch = sm.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e?.type !== "message") continue;
			const m = e.message as RawMessage;
			if (m.role !== "user") continue;
			// timestamp 同时给出时必须相等（毫秒碰撞军见，双重锚定防同文消息错配）
			if (ref.timestamp !== undefined && m.timestamp !== ref.timestamp) continue;
			if (ref.text !== undefined && blockText(m.content) !== ref.text) continue;
			return e.id;
		}
	}
	throw new Error("Recall target message not found");
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
			const toolBlocks = blockToolCalls(content);
			const tools = toolBlocks.map((b) => b.tool);
			for (const tool of tools) toolById.set(tool.id, tool);
			const text = blockText(raw.content);
			// 正文后的工具（块序在首个 text 块之后，同 turn 内 text→toolCall 交错）：拆成独立 meta 消息
			// 排在正文消息之后，与 renderer finalizeStreaming 的拆分一致——否则渲染时会被倒挂到正文上方
			const textIndex = content.findIndex((c) => c?.type === "text" && c.text);
			const postBlocks = text && textIndex >= 0 ? toolBlocks.filter((b) => b.index > textIndex) : [];
			if (postBlocks.length > 0) {
				const preTools = toolBlocks.filter((b) => b.index < textIndex).map((b) => b.tool);
				const timestamp = raw.timestamp ?? Date.now();
				if (text || preTools.length > 0) {
					out.push({
						role: "assistant",
						text,
						thinking: blockThinking(content),
						tools: preTools,
						images: [],
						timestamp,
					});
				}
				out.push({
					role: "assistant",
					text: "",
					thinking: "",
					tools: postBlocks.map((b) => b.tool),
					images: [],
					timestamp,
				});
				continue;
			}
			const message: SessionMessage = {
				role: "assistant",
				text,
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
				// show_image：图片从 details 提取为独立图片消息（紧随其 assistant 消息之后）
				if (tool.name === "show_image" && !tool.isError) {
					const shown = showImageFromDetails(raw.details);
					if (shown) {
						out.push({
							role: "image",
							images: shown.images,
							paths: shown.paths,
							timestamp: raw.timestamp ?? Date.now(),
						});
					}
				}
				// subagent：details 带 results/sessionFile → 独立子代理消息（结构检测，不依赖工具名）
				if (!tool.isError) {
					const runs = extractSubagentRuns(raw.details);
					if (runs) {
						out.push({
							role: "subagent",
							runs,
							timestamp: raw.timestamp ?? Date.now(),
						});
					}
				}
			}
		}
	}
	return out;
}
