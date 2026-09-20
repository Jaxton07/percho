import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionResult,
	createAgentSession,
	type DefaultResourceLoader,
	type ExtensionError,
	getAgentDir,
	ModelRuntime,
	ProjectTrustStore,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
	type SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	AvailableModel,
	ContextManagerMode,
	ContextUsageInfo,
	CreateSessionOptions,
	ExtensionDialogRequest,
	ExtensionDialogResolved,
	ExtensionDialogRespond,
	ExtensionEditorTextEvent,
	ExtensionNotifyEvent,
	ImageInput,
	LoadedResources,
	LoginEventPayload,
	PermissionAnswer,
	PermissionMode,
	PermissionRequest,
	PermissionResolved,
	QuotaInfo,
	SessionEvent,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SlashCommandInfo,
	SubagentInfo,
	TrustAnswer,
	TrustRequest,
} from "@percho/shared";
import {
	extractTodos,
	formatSkillCommand,
	parseExpandedSkillInvocation,
	TODO_REMINDER_CUSTOM_TYPE,
	TODO_TOOL_NAME,
	type TodoItem,
} from "@percho/shared";
import { Emitter } from "./emitter";
import { createLogger } from "./log";
import { PackageAdmin } from "./packages/admin";
import { loadPermissionConfig } from "./permissions";
import {
	makePermissionGateExtension,
	type PermissionConfirm,
	type PermissionModeRef,
} from "./permissions/extension";
import { PermissionGate } from "./permissions/gate";
import { walkProjectFiles } from "./project/files";
import { TrustGate } from "./project/trust";
import { ProjectResourceLoader } from "./project/trust-loader";
import { addAllowedPattern, addWorkspaceRoot } from "./project/workspace-store";
import { slimBulkyEvent, slimMessageUpdate } from "./session/event-slim";
import { ExtensionDialogHost } from "./session/extension-dialog-host";
import {
	assignEntryIds,
	blockImages,
	blockText,
	type RawMessage,
	readSessionMessagesFromContent,
	resolveForkEntryId,
	resolveRecallEntryId,
	toSessionMessages,
} from "./session/messages";
import { autoNameSession } from "./session/naming";
import { EventRateTracker } from "./session/rates";
import { type EventForwarder, type RegisteredSession, SessionRegistry } from "./session/registry";
import { renameSessionFile } from "./session/rename";
import { StreamGuard } from "./session/stream-guard";
import { TraceRecorder } from "./session/trace";
import { SessionTraces } from "./session/traces";
import { makeUiContext } from "./session/ui-context";
import { LoginService } from "./settings/login";
import { ModelPrefsService } from "./settings/model-prefs";
import { makeQuotaService } from "./settings/quota";
import { SettingsService } from "./settings/settings";
import { slashCommandsForLoader, slashCommandsForSession } from "./slash-commands";
import {
	makeChannelWatchExtension,
	readChannelWatchEnabled,
	writeChannelWatchEnabled,
} from "./tools/channel-watch";
import {
	makeEvapExtension,
	readContextManagerMode,
	reportEvapBatch,
	writeContextManagerMode,
} from "./tools/context-evaporation";
import { makeShowImageTool } from "./tools/show-image";
import { discoverAgents, isSubagentSessionPath, makeSubagentTool } from "./tools/subagent";
import { applySubagentMutex, resolveSubagentPreferBuiltin } from "./tools/subagent/mutex";
import { makeTodoTool } from "./tools/todo";
import { makeTodoReminderExtension } from "./tools/todo-reminder";
import { makeWebFetchTool } from "./tools/webfetch";

const log = createLogger("backend");

/** SessionManager 磁盘枚举项 → SessionMeta（listSessions/listAllSessions 共用） */
function sessionInfoToMeta(
	info: SessionInfo,
	opts: { cwdFallback: string; active: boolean; readOnly?: boolean },
): SessionMeta {
	return {
		sessionId: info.id,
		sessionFile: info.path,
		cwd: info.cwd || opts.cwdFallback,
		name: info.name,
		active: opts.active,
		readOnly: opts.readOnly || undefined,
		messageCount: info.messageCount,
		createdAt: info.created.getTime(),
		modifiedAt: info.modified.getTime(),
	};
}

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
	/** 内置 subagent 优先于第三方 subagent 扩展（默认 true） */
	subagentPreferBuiltin?: boolean;
	/**
	 * 桌面端集成（Electron 专用；纯 CLI 环境不传）：
	 * appendSystemPrompt = 追加进每次会话系统提示词的段落（如「你运行在 Percho 桌面端，界面可被 UI 插件定制」）；
	 * additionalSkillPaths = 额外技能目录（如随包分发的 percho-ui-plugin skill，描述原生进可用技能清单）。
	 */
	desktopIntegration?: {
		appendSystemPrompt: string[];
		additionalSkillPaths: string[];
	};
}

/**
 * PiBackend：pi SDK 的唯一适配层（门面）。不依赖 Electron，
 * 主进程与（未来的）独立 server 均可复用。
 *
 * 领域实现拆在同包模块（各文件单一职责）：
 * - slash-commands.ts     斜杠命令清单（内置/模板/skill/扩展）
 * - session/messages.ts   pi 消息 → SessionMessage 解析与 entryId 配对（fork/recall/回放共用）
 * - packages/admin.ts     社区包安装/卸载/搜索 + 会话热重载
 * - project/trust-loader.ts 两阶段项目资源加载 + 信任决策
 * - session/traces.ts     会话事件 trace 生命周期
 * - emitter.ts            泛型订阅/分发原语（9 套事件管线共用）
 * - settings/quota.ts     opencode-go 套餐额度（TTL 缓存 + 官方 API）
 */
export class PiBackend {
	private readonly registry = new SessionRegistry();
	/**
	 * 已加载会话的频道订阅快照（spec §6.1/§6.2）：sessionId → 有效运行态 topic 集，
	 * 由 channel-watch 扩展经 `reportChannelSubscriptions` 维护（只存 topic 名）。
	 * 阶段 0 只建管道，GC 守卫/查询 IPC 见 plan 阶段 1。
	 */
	private readonly channelSubscriptionIds = new Map<string, Set<string>>();
	/** 用户级模型可见性与子代理模型偏好（独立于 CLI 共用 settings.json）。readonly 直暴露 */
	readonly modelPrefs = new ModelPrefsService(join(getAgentDir(), "model-prefs.json"));
	/** 社区包管理（安装/卸载 + 会话热重载）。readonly 直暴露 */
	readonly packages: PackageAdmin;
	private readonly eventEmitter = new Emitter<{ sessionId: string; event: SessionEvent }>();
	private readonly permissionEmitter = new Emitter<PermissionRequest>();
	private readonly permissionResolvedEmitter = new Emitter<PermissionResolved>();
	private readonly trustEmitter = new Emitter<TrustRequest>();
	private readonly loginEmitter = new Emitter<LoginEventPayload>();
	private readonly extensionDialogRequestEmitter = new Emitter<ExtensionDialogRequest>();
	private readonly extensionDialogResolvedEmitter = new Emitter<ExtensionDialogResolved>();
	private readonly extensionNotifyEmitter = new Emitter<ExtensionNotifyEvent>();
	private readonly extensionEditorTextEmitter = new Emitter<ExtensionEditorTextEvent>();
	/** 项目信任决策记录（~/.pi/agent/trust.json，与 CLI 共享）+ 信任请求门控 */
	private readonly trustStore = new ProjectTrustStore(getAgentDir());
	private readonly trustGate = new TrustGate((req) => this.trustEmitter.emit(req));
	/** 会话事件 trace（JSONL，离线可重放） */
	private readonly traces = new SessionTraces();
	private readonly streamGuard = new StreamGuard();
	/** 每会话事件速率（60s 窗口；心跳/临终快照数据源） */
	private readonly eventRates = new EventRateTracker();
	private modelRuntime: ModelRuntime | undefined;
	private modelPromise: Promise<ModelRuntime> | undefined;
	/** 设置页（provider/模型/凭证配置）服务 */
	readonly settings = new SettingsService(() => this.getModelRuntime());
	/** opencode-go 套餐额度（TTL 缓存；无 key 返回 null） */
	private readonly quota = makeQuotaService(() => this.getModelRuntime());
	/** provider 交互登录服务（OAuth + api_key 交互，如 Google Vertex），事件经 onLoginEvent 分发 */
	readonly login = new LoginService({
		getRuntime: () => this.getModelRuntime(),
		send: (payload) => this.loginEmitter.emit(payload),
	});
	/** 项目资源两阶段加载 + 信任决策 */
	private readonly projectLoader: ProjectResourceLoader;

	constructor(private readonly options: PiBackendOptions = {}) {
		this.packages = new PackageAdmin({ registry: this.registry, defaultCwd: options.defaultCwd });
		this.projectLoader = new ProjectResourceLoader({
			trustStore: this.trustStore,
			ask: (dir, opts) => this.trustGate.ask(dir, opts),
			canAsk: () => this.trustEmitter.size > 0,
			buildExtensions: (cwd, confirm, modeRef) => this.buildExtensionFactories(cwd, confirm, modeRef),
			projectTrust: options.projectTrust,
			desktopIntegration: options.desktopIntegration,
		});
	}

	/** 自定义工具 = 调用方传入的 + 内置 webfetch（webFetch:false 关闭）+ show_image + todo + subagent */
	private buildCustomTools(gate: PermissionGate, preferBuiltin: boolean): ToolDefinition[] {
		const tools = [...(this.options.customTools ?? [])];
		const webFetch = this.options.webFetch;
		if (webFetch !== false) {
			tools.push(makeWebFetchTool(typeof webFetch === "object" ? webFetch : undefined));
		}
		tools.push(makeShowImageTool());
		tools.push(makeTodoTool());
		if (preferBuiltin) {
			tools.push(
				makeSubagentTool({
					getModelRuntime: () => this.getModelRuntime(),
					getSubagentModel: (agentName) => this.modelPrefs.getSubagentModel(agentName),
					getSubagentThinkingLevel: (agentName) => this.modelPrefs.getSubagentThinking(agentName),
					gate,
					traces: this.traces,
					onEvent: (sessionId, event) => this.emitEvent(sessionId, event),
				}),
			);
		}
		return tools;
	}

	/**
	 * 内置 subagent 执行器是否优先：构造参数（测试/嵌入宿主 override）> model-prefs.json 实时值 > true。
	 * 只影响新会话创建（调用点已 async，故在最早异步点预读一次，避免同步 buildCustomTools 内读盘）。
	 */
	private async subagentPreferBuiltin(): Promise<boolean> {
		return resolveSubagentPreferBuiltin(
			this.options.subagentPreferBuiltin,
			await this.modelPrefs.getSubagentPreferBuiltin(),
		);
	}

	/**
	 * 内置扩展随资源加载器注册（inline factory，不受项目信任影响）。注册序即
	 * context 钩子链序（V2 冒烟实证）：权限门控（无 context 钩子）→ 视觉代理
	 * （image→文本，先文本化）→ 上下文蒸发（基于文本化内容做蒸发决策，
	 * 需保住视觉代理的替换）→ todo-reminder（恢复注入最后，不被压）。
	 * 权限门控受 permissionGates/permissionExtension 开关控制（permissionGates=false
	 * 时 confirm 恒 false，不能注册）；视觉代理 handler 实时读配置，设置页保存后立即
	 * 生效；上下文蒸发默认开启（缺省 mode=evaporation），设置页可切 off，切换 ≤2s
	 * 生效免重开会话；subagent 子会话不加载本工厂——noExtensions，见 runner.ts）。
	 */
	private buildExtensionFactories(
		cwd: string,
		confirm: PermissionConfirm | undefined,
		modeRef?: PermissionModeRef,
	): Array<
		| ReturnType<typeof makeTodoReminderExtension>
		| ReturnType<typeof makeChannelWatchExtension>
		| ReturnType<typeof makeEvapExtension>
	> {
		const factories: Array<
			| ReturnType<typeof makeTodoReminderExtension>
			| ReturnType<typeof makeChannelWatchExtension>
			| ReturnType<typeof makeEvapExtension>
		> = [];
		if (this.options.permissionGates !== false && this.options.permissionExtension !== false) {
			// confirm 直接桥到 PermissionGate（携带 kind/suggestDir 元数据，驱动「允许此目录」）；
			// 未提供时扩展自行回退 ctx.ui.confirm（无元数据）；modeRef 同款闭包注入（D1：
			// 按会话内存态，每次 tool_call 实时读，无 modeRef 的调用方如 draft 斜杠命令恒 default）
			factories.push(
				makePermissionGateExtension(getAgentDir(), {
					projectRoot: cwd,
					confirm,
					getMode: () => modeRef?.current ?? "default",
				}),
			);
		}
		// 上下文蒸发（默认开启：缺省 mode=evaporation；钩子实时读派生 mode，
		// 设置页切换后 ≤2s 生效，无需重开会话）。
		// 批次上报双通道：log（快速 grep）+ trace_custom 行（灰度分析脚本直读，
		// reducer 未知类型 no-op，replay-trace.mts 重放安全）
		factories.push(
			makeEvapExtension({
				agentDir: getAgentDir(),
				reporter: (sessionId, batch) => {
					reportEvapBatch(sessionId, batch);
					this.traces.recordCustom(sessionId, "evap_batch", batch);
				},
			}),
		);
		// channel-watch 跨会话协作（开关默认开；session_start 检查开关 + trusted 门，
		// 无订阅时零 fs 监听；钩子与蒸发/todo 无语义交互，位置不敏感，放 todo 前）
		factories.push(makeChannelWatchExtension({ agentDir: getAgentDir(), cwd }));
		// todo-reminder 最后：compaction 后恢复注入的任务列表不被上游折叠
		factories.push(makeTodoReminderExtension());
		return factories;
	}

	/**
	 * 扩展绑定（无条件，与权限门逃生舱解耦）：对话框宿主 + mode "rpc"（官方半可用语义，
	 * D9：hasUI=true + 对话框可用 + TUI 专属明确降级）+ onError 接 log/trace。
	 * 子代理 runner 不走这里（子会话用 makeUiContext({}) 纯 no-op）。
	 */
	private async bindSessionExtensions(
		session: AgentSession,
		sessionId: string,
	): Promise<ExtensionDialogHost> {
		const dialogs = new ExtensionDialogHost({
			onRequest: (req) => this.extensionDialogRequestEmitter.emit(req),
			onResolved: (result) => this.extensionDialogResolvedEmitter.emit(result),
		});
		dialogs.bind(sessionId);
		const recordExtensionError = (err: ExtensionError): void => {
			log.error("extension error", sessionId, err);
			try {
				this.traces.recordCustom(sessionId, "extension_error", {
					path: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			} catch {
				// trace 不可用不影响扩展运行
			}
		};
		await session.bindExtensions({
			uiContext: makeUiContext({
				dialogs,
				onNotify: (message, level, source) =>
					this.extensionNotifyEmitter.emit({ sessionId, extensionPath: source, message, level }),
				onEditorText: (text, source) => this.extensionEditorTextEmitter.emit({ sessionId, text, source }),
			}),
			mode: "rpc",
			onError: recordExtensionError,
		});
		return dialogs;
	}

	private async getModelRuntime(): Promise<ModelRuntime> {
		if (this.modelRuntime) return this.modelRuntime;
		if (!this.modelPromise) {
			this.modelPromise = ModelRuntime.create();
		}
		this.modelRuntime = await this.modelPromise;
		return this.modelRuntime;
	}

	private emitEvent(sessionId: string, event: SessionEvent): void {
		this.eventRates.tick(sessionId);
		// 会话标题全量落一行日志（决策 7：不截断）：用户拿 UI 里看到的标题（含自动命名的 …）
		// 能直接 grep 主日志定位会话，不再只靠 prompt 行的 120 字符截断
		if (event.type === "session_info_changed") log.info("session renamed", sessionId, { name: event.name });
		// message_update 携带全量快照（partial + message），平方放大事故源头，先瘦身再分发
		if (event.type === "message_update") event = slimMessageUpdate(event);
		// toolResult 大结果四份快照重复携带（0.5.2 白屏事故降压层）：image base64 剥除 + 超长 text 截断
		event = slimBulkyEvent(event);
		// 流式熔断：病态输出（空白洪流/超量）trip 后 abort 会话，并丢弃后续增量（trace 与转发同步止血）
		const verdict = this.streamGuard.inspect(sessionId, event);
		if (verdict !== "pass") {
			if (verdict !== "suppress") {
				log.error("stream guard tripped, aborting session", sessionId, { verdict });
				void this.abort(sessionId).catch(() => {});
				// 熔断显形：合成 stream_guard_tripped UI 事件（subagent_mutex 同款：union + IPC 转发 +
				// 不进 trace），reducer 产 warning 条——否则「回复戛然而止」零 UI 信号。
				// 合成事件直接 emit，不喂回 streamGuard.inspect（防线不能自触发）。
				this.eventEmitter.emit({ sessionId, event: { type: "stream_guard_tripped", verdict } });
			}
			return;
		}
		if (event.type !== "subagent_mutex" && event.type !== "stream_guard_tripped")
			this.traces.record(sessionId, event);
		this.eventEmitter.emit({ sessionId, event });
	}

	async init(): Promise<void> {
		await this.getModelRuntime();
	}

	/** 项目文件列表（@ 补全数据源，相对路径、目录带尾 /，TTL 缓存） */
	async listProjectFiles(cwd?: string): Promise<string[]> {
		return walkProjectFiles(cwd || this.options.defaultCwd || process.cwd());
	}

	async createSession(options: CreateSessionOptions): Promise<SessionMeta> {
		const runtime = await this.getModelRuntime();
		const cwd = options.cwd || this.options.defaultCwd || process.cwd();
		const model =
			options.provider && options.modelId ? runtime.getModel(options.provider, options.modelId) : undefined;
		const session = await this.wireSession(cwd, undefined, async (deps) => {
			const { settingsManager, resourceLoader } = await deps.load();
			return createAgentSession({
				cwd,
				modelRuntime: runtime,
				model,
				thinkingLevel: options.thinkingLevel as ThinkingLevel | undefined,
				tools: this.options.tools,
				customTools: this.buildCustomTools(deps.gate, deps.preferBuiltin),
				sessionManager: SessionManager.create(cwd),
				settingsManager,
				resourceLoader,
			});
		});
		log.info("session created", session.sessionId, { cwd });
		return this.toMetaOrThrow(session.sessionId);
	}

	async openSession(filePath: string): Promise<SessionMeta> {
		const runtime = await this.getModelRuntime();
		const sessionManager = SessionManager.open(filePath);
		const cwd = sessionManager.getCwd() || process.cwd();
		// 子代理产物目录下的会话文件 = 只读检视（spec §8.1：防能力静默漂移/递归绕过）。
		// 其运行 trace 由 runner 管理，检视页不可写，故不另建 recorder（避免覆盖运行中的 recorder）。
		const readOnly = isSubagentSessionPath(filePath);
		const session = await this.wireSession(cwd, readOnly, async (deps) => {
			const { settingsManager, resourceLoader } = await deps.load();
			return createAgentSession({
				sessionManager,
				modelRuntime: runtime,
				// 与 create 对称应用工具白名单（F1 修复；SDK 仅在初始激活工具集层面消费，
				// 会话文件不持久化工具开关，重开无状态冲突）
				tools: this.options.tools,
				settingsManager,
				resourceLoader,
				customTools: this.buildCustomTools(deps.gate, deps.preferBuiltin),
			});
		});
		log.info("session opened", session.sessionId, { file: filePath });
		return this.toMetaOrThrow(session.sessionId);
	}

	/**
	 * create/open 共有接线：权限三件套（gate/confirmBridge/modeRef）→ 资源加载 → 会话构造
	 * （差异项由 makeSession 提供：create 传 model/tools/thinkingLevel 与新 manager；open 传
	 * 既有 manager + tools，model/thinkingLevel 有意不传——SDK 缺省时从会话文件恢复，
	 * 传了反而覆盖用户原选择，见 sdk.js 恢复分支）→
	 * subagent mutex 通知 → 扩展绑定 → 订阅/注册（gate/dialogs/modeRef 随 entry 单记录）→ trace。
	 */
	private async wireSession(
		cwd: string,
		readOnly: boolean | undefined,
		makeSession: (deps: {
			gate: PermissionGate;
			preferBuiltin: boolean;
			/** 两阶段资源加载（信任决策走 projectLoader 既有链路）；懒执行：makeSession 决定时机 */
			load: () => Promise<{ settingsManager: SettingsManager; resourceLoader: DefaultResourceLoader }>;
		}) => Promise<CreateAgentSessionResult>,
	): Promise<AgentSession> {
		const gate = new PermissionGate((req) => this.permissionEmitter.emit(req));
		// 权限扩展的确认通道直接桥到 gate（携带 kind/suggestDir 元数据，驱动「允许此目录」/持久化）
		const confirmBridge: PermissionConfirm = (title, message, meta) => gate.confirm(title, message, meta);
		// 会话权限模式引用：一律 default 起步（D1：不落盘、不继承），随工厂闭包注入求值链
		const modeRef: PermissionModeRef = { current: "default" };
		let loaded: { settingsManager: SettingsManager; resourceLoader: DefaultResourceLoader } | undefined;
		const load = async () => {
			loaded ??= await this.projectLoader.load(cwd, { confirm: confirmBridge, modeRef });
			return loaded;
		};
		const preferBuiltin = await this.subagentPreferBuiltin();
		const { session, extensionsResult } = await makeSession({ gate, preferBuiltin, load });
		const mutex = applySubagentMutex(session, extensionsResult, preferBuiltin);
		if (mutex.shadowed.length > 0) {
			log.info("third-party subagent tools shadowed", session.sessionId, mutex);
			for (const shadowed of mutex.shadowed) {
				this.emitEvent(session.sessionId, {
					type: "subagent_mutex",
					extensionPath: shadowed.extensionPath,
					tools: shadowed.tools,
				});
			}
		}
		gate.bindSession(session.sessionId);
		const dialogs = await this.bindSessionExtensions(session, session.sessionId);
		const unsubscribe = session.subscribe((event) => {
			autoNameSession(session, event);
			this.emitEvent(session.sessionId, event);
		});
		this.registry.add({
			session,
			unsubscribe,
			cwd,
			gate,
			dialogs,
			modeRef,
			readOnly: readOnly || undefined,
		});
		if (!readOnly) await this.traces.start(session.sessionId, session.sessionManager.getSessionDir());
		return session;
	}

	async listSessions(cwd?: string): Promise<SessionMeta[]> {
		const target = cwd || this.options.defaultCwd || process.cwd();
		const activeIds = this.activeSessionIds();
		return (await SessionManager.list(target))
			.filter((info) => !activeIds.has(info.id))
			.map((info) => sessionInfoToMeta(info, { cwdFallback: target, active: false }));
	}

	/** 跨全部项目目录枚举会话（项目管理页用，含活跃会话） */
	async listAllSessions(): Promise<SessionMeta[]> {
		const activeIds = this.activeSessionIds();
		return (await SessionManager.listAll())
			.filter((info) => info.cwd)
			.map((info) =>
				sessionInfoToMeta(info, {
					cwdFallback: "",
					active: activeIds.has(info.id),
					// subagent 产物会话只读（LAN 列表/写端点禁用判定用）
					readOnly: isSubagentSessionPath(info.path) || undefined,
				}),
			);
	}

	private activeSessionIds(): Set<string> {
		return new Set(this.registry.list().map((e) => e.session.sessionId));
	}

	/**
	 * channel-watch 扩展回调入口（spec §6.1）：上报该会话当前的「有效运行态订阅」快照。
	 * 只存 topic 名（不存消息内容）；空集 = 移出快照（退订最后一个 topic 即恢复普通 GC 资格）。
	 * 这里只存取快照，不做保护策略（策略在 closeSession 的 intent 守卫与 renderer 纯策略层）。
	 */
	reportChannelSubscriptions(sessionId: string, topics: ReadonlySet<string>): void {
		if (topics.size === 0) this.channelSubscriptionIds.delete(sessionId);
		else this.channelSubscriptionIds.set(sessionId, new Set(topics));
	}

	/** renderer GC 查询用（spec §6.2）：当前有有效频道订阅的会话 ID（顺序不构成契约） */
	getChannelSubscriptionSessionIds(): string[] {
		return [...this.channelSubscriptionIds.keys()];
	}

	/**
	 * 关会话（**用户主动关**）：agent 还在跑（含等审批）时拒绝——run 中途把后端会话 dispose 会直接掐断本轮，
	 * 内存策略（自动卸载）靠这道兵底兼固（策略层已保护，这里是最后一道门）。
	 * 自动卸载走同一个方法：行为与主动关完全一致，只是调用点分开（renderer 侧 `unloadSession`）。
	 */
	async closeSession(sessionId: string, _intent?: "user" | "gc"): Promise<{ closed: boolean }> {
		const entry = this.registry.get(sessionId);
		// 没有该会话 = 它本来就没在跑（幂等成功）：调用方该照常清掉自己的会话条目
		if (!entry) return { closed: true };
		if (entry.session.isStreaming) {
			// 等审批也在此列（实测 isStreaming 两态都为 true）：用户切走/自动卸载都不能把这一轮掐掉
			log.warn("closeSession ignored: streaming", sessionId);
			return { closed: false };
		}
		await this.disposeSession(entry);
		return { closed: true };
	}

	/** 真正的处置：dispose + registry/全局键控子系统清理（closeSession 与 deleteSession 共用） */
	private async disposeSession(entry: RegisteredSession): Promise<void> {
		const sessionId = entry.session.sessionId;
		entry.session.dispose();
		// entry 级清理：unsubscribe + gate/dialogs dispose（pending 对话框按 sessionClosed 结算，
		// 广播 resolved 让 renderer 撤卡；扩展 Promise 落取消值）
		this.registry.delete(sessionId);
		// 全局键控子系统（本就独立于 registry）
		this.streamGuard.cleanup(sessionId);
		this.eventRates.delete(sessionId);
		await this.traces.stop(sessionId);
		log.info("session closed", sessionId);
	}

	/** 删除历史会话（pi 无删除 API，会话即磁盘 jsonl，直接删文件） */
	async deleteSession(sessionId: string, sessionFile?: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		const sessionDir = entry?.session.sessionManager.getSessionDir();
		const file = sessionFile ?? entry?.session.sessionManager.getSessionFile();
		// 显式删除是用户的明确意图（既有行为：即便正跑着也删），**绕开 closeSession 的 isStreaming 拒绝**，
		// 否则会变成「拒绝 dispose 但磁盘文件照删」的跛脚状态（阶段 0 实测确认这条路径不先 abort）
		if (entry) await this.disposeSession(entry);
		if (!file) throw new Error(`Session file not found: ${sessionId}`);
		await unlink(file);
		if (sessionDir) await TraceRecorder.removeAll(sessionDir, sessionId);
		log.info("session deleted", sessionId);
	}

	async prompt(sessionId: string, text: string, images?: ImageInput[]): Promise<void> {
		const entry = this.requireWritable(sessionId);
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

	/** LAN 远程写端点前置检查（registry 直查，无磁盘 IO）。 */
	checkSessionWritable(sessionId: string): "ok" | "not_found" | "read_only" {
		const entry = this.registry.get(sessionId);
		if (!entry) return "not_found";
		if (entry.readOnly) return "read_only";
		return "ok";
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
		const entry = this.requireWritable(sessionId);
		const runtime = await this.getModelRuntime();
		const model = runtime.getModel(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await entry.session.setModel(model);
	}

	async setThinkingLevel(sessionId: string, level: string): Promise<void> {
		const entry = this.requireWritable(sessionId);
		entry.session.setThinkingLevel(level as ThinkingLevel);
	}

	async compact(sessionId: string, customInstructions?: string): Promise<void> {
		const entry = this.requireWritable(sessionId);
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

	/** 每会话事件速率快照（心跳/临终快照数据源）：最近 60s 每秒事件数 + 最近事件时刻。
	 * 顺带回收已结束会话（subagent 子会话不走 closeSession）的残留条目。 */
	getEventRates(): Map<string, { window60s: number[]; lastEventAt: number }> {
		this.eventRates.prune((id) => this.registry.has(id));
		return this.eventRates.snapshot();
	}

	/** 全部活跃会话的运行态快照（只读观察者用）。 */
	listActiveSessionRuntime(): { sessionId: string; streaming: boolean; compacting: boolean }[] {
		return this.registry.list().map(({ session }) => ({
			sessionId: session.sessionId,
			streaming: session.isStreaming,
			compacting: session.isCompacting,
		}));
	}

	/** 全部未决权限请求的只读快照（LAN Observer 等被动观察者用）。 */
	/** 全部未决权限请求快照（含 requestId；LAN 观察/远程应答与桌面共用） */
	getPendingPermissionRequests(): PermissionRequest[] {
		return this.registry.list().flatMap(({ gate }) => gate.listPending());
	}

	/** 当前模型上下文使用情况；刚压缩后 tokens 未知（null），会话无模型时 percent 为 null */
	async getContextUsage(sessionId: string): Promise<ContextUsageInfo | null> {
		const entry = this.requireSession(sessionId);
		const usage = entry.session.getContextUsage();
		if (!usage) return null;
		return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
	}

	/** opencode-go 套餐额度（实现在 settings/quota.ts：TTL 缓存 + 官方 API） */
	async getQuota(): Promise<QuotaInfo | null> {
		return this.quota.get();
	}

	/** 列出斜杠命令：内置（标记 supported）+ prompt 模板 + skill + 扩展命令 */
	async listSlashCommands(sessionId: string): Promise<SlashCommandInfo[]> {
		return slashCommandsForSession(this.requireSession(sessionId).session);
	}

	/**
	 * 无会话列出斜杠命令（draft 新会话的补全数据源）：三类命令都只依赖
	 * DefaultResourceLoader（扩展命令在加载期注册进 ext.commands），无需建会话。
	 * 信任未决的项目不弹窗、按不信任只加载用户级资源（弹窗已在选目录时前置）。
	 */
	async listSlashCommandsForCwd(cwd?: string): Promise<SlashCommandInfo[]> {
		const target = cwd || this.options.defaultCwd || process.cwd();
		const { resourceLoader } = await this.projectLoader.load(target, { askTrust: false });
		return slashCommandsForLoader(resourceLoader);
	}

	/** 项目信任前置决策（添加项目/切换 draft cwd 时由 renderer 调用） */
	async ensureProjectTrust(cwd: string): Promise<boolean> {
		return this.projectLoader.ensureTrust(cwd);
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
				tools: [...ext.tools.keys()],
				commands: [...ext.commands.keys()],
				flagsCount: ext.flags.size,
				shortcutsCount: ext.shortcuts.size,
			})),
			extensionErrors: extResult.errors,
		};
	}

	/** 设置会话显示名：活跃会话走 SDK（自动发 session_info_changed）；历史会话离线写会话文件（无事件，渲染端本地更新标题） */
	async setSessionName(sessionId: string, name: string): Promise<void> {
		const entry = this.registry.get(sessionId);
		if (entry) {
			if (entry.readOnly) throw new Error("Session is read-only (subagent transcript)");
			entry.session.setSessionName(name);
			return;
		}
		// 历史会话（顶栏没打开的）：从磁盘枚举拿到文件路径，离线追加 session_info（与 CLI /name 同源）
		const meta = (await this.listAllSessions()).find((s) => s.sessionId === sessionId);
		if (!meta) throw new Error(`Session not found: ${sessionId}`);
		if (meta.readOnly) throw new Error("Session is read-only (subagent transcript)");
		if (!meta.sessionFile) throw new Error(`Session has no file: ${sessionId}`);
		renameSessionFile(meta.sessionFile, name);
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
		// 配对消息与会话树 entry id（assistant 供 fork 定位、user 供撤回定位）
		assignEntryIds(messages, entry.session.sessionManager.getBranch());
		return messages;
	}

	/**
	 * LAN 历史会话只读透视：活跃会话走 registry（同 getSessionMessages）；
	 * 未打开的会话纯解析文件（不开 SessionManager，零副作用零写盘）。不存在返回 null。
	 */
	async peekSessionMessages(sessionId: string): Promise<SessionMessage[] | null> {
		if (this.registry.get(sessionId)) return this.getSessionMessages(sessionId);
		const meta = (await this.listAllSessions()).find((s) => s.sessionId === sessionId);
		if (!meta?.sessionFile) return null;
		try {
			const content = await readFile(meta.sessionFile, "utf8");
			return readSessionMessagesFromContent(content);
		} catch {
			return null;
		}
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
		const entry = this.requireWritable(sessionId);
		if (entry.session.isStreaming || entry.session.isCompacting) {
			throw new Error("Cannot fork while the agent is running or context is compacting");
		}
		const sourceManager = entry.session.sessionManager;
		const targetId = resolveForkEntryId(sourceManager, ref);
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
		const entry = this.requireWritable(sessionId);
		if (entry.session.isStreaming || entry.session.isCompacting) {
			throw new Error("Cannot recall while the agent is running or context is compacting");
		}
		const sm = entry.session.sessionManager;
		const targetId = resolveRecallEntryId(sm, ref);
		const target = sm.getEntry(targetId) as Extract<SessionEntry, { type: "message" }>;
		const message = target.message as RawMessage;
		// 文本/图片从目标 entry 提取（navigateTree 只返回 editorText，图片会丢）
		const sourceText = blockText(message.content);
		const invocation = parseExpandedSkillInvocation(sourceText);
		const text = invocation ? formatSkillCommand(invocation) : sourceText;
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
		const [providers, prefs, runtime] = await Promise.all([
			this.settings.listProviders(),
			this.modelPrefs.getPrefs(),
			this.getModelRuntime(),
		]);
		return providers.flatMap((provider) =>
			provider.configured
				? provider.models
						.filter((model) => !prefs.hiddenModels[provider.id]?.includes(model.id))
						.map((model) => {
							// 该模型实际支持的思考深度（SDK 按 reasoning/thinkingLevelMap 判定；不推理的模型只有 off）
							// + 图片输入能力（input 含 image；查不到则缺省，UI fail-open）
							let thinkingLevels: string[] | undefined;
							let imageInput: boolean | undefined;
							try {
								const m = runtime.getModel(provider.id, model.id);
								if (m) {
									thinkingLevels = getSupportedThinkingLevels(m);
									imageInput = m.input.includes("image");
								}
							} catch {
								thinkingLevels = undefined;
								imageInput = undefined;
							}
							return {
								provider: provider.id,
								providerName: provider.name,
								id: model.id,
								label: model.name,
								authed: true,
								thinkingLevels,
								imageInput,
							};
						})
				: [],
		);
	}

	async listSubagents(): Promise<SubagentInfo[]> {
		const agents = await discoverAgents(this.options.defaultCwd ?? process.cwd(), { projectTrusted: false });
		return agents
			.filter((agent) => agent.source !== "project")
			.map(({ name, description, source, thinking, thinkingWarning }) => ({
				name,
				description,
				source: source === "builtin" ? "builtin" : "user",
				...(thinking ? { thinking } : {}),
				...(thinkingWarning ? { thinkingWarning } : {}),
			}));
	}

	onEvent(handler: (sessionId: string, event: SessionEvent) => void): () => void {
		return this.eventEmitter.subscribe(({ sessionId, event }) => handler(sessionId, event));
	}

	onPermissionRequest(handler: (req: PermissionRequest) => void): () => void {
		return this.permissionEmitter.subscribe(handler);
	}

	/** 权限请求被桌面端实际应答后通知被动观察者。 */
	onPermissionResolved(handler: (result: PermissionResolved) => void): () => void {
		return this.permissionResolvedEmitter.subscribe(handler);
	}

	onTrustRequest(handler: (req: TrustRequest) => void): () => void {
		return this.trustEmitter.subscribe(handler);
	}

	onLoginEvent(handler: (payload: LoginEventPayload) => void): () => void {
		return this.loginEmitter.subscribe(handler);
	}

	/** 扩展对话框请求/结算/通知/草稿预填订阅（main 进程转发 renderer 用） */
	onExtensionDialogRequest(handler: (req: ExtensionDialogRequest) => void): () => void {
		return this.extensionDialogRequestEmitter.subscribe(handler);
	}

	onExtensionDialogResolved(handler: (result: ExtensionDialogResolved) => void): () => void {
		return this.extensionDialogResolvedEmitter.subscribe(handler);
	}

	onExtensionNotify(handler: (event: ExtensionNotifyEvent) => void): () => void {
		return this.extensionNotifyEmitter.subscribe(handler);
	}

	onExtensionEditorText(handler: (event: ExtensionEditorTextEvent) => void): () => void {
		return this.extensionEditorTextEmitter.subscribe(handler);
	}

	/** renderer 应答扩展对话框（requestId 含 sessionId 全局唯一；非本宿主实例静默忽略，仿 respondPermission 遍历） */
	respondExtensionDialog(requestId: string, answer: ExtensionDialogRespond): void {
		for (const { dialogs } of this.registry.list()) {
			dialogs.respond(requestId, answer);
		}
	}

	respondPermission(requestId: string, answer: PermissionAnswer): void {
		if (answer === "allowDir" || answer === "allowAlways") {
			// 持久化决策（仅内置权限扩展的请求带 meta）：
			// allowDir → 根加入 workspaces.json（本次与后续均按界内处置）；
			// allowAlways → 模式键记入当前项目的 allowed[]（跨会话生效）
			for (const { gate } of this.registry.list()) {
				const req = gate.getRequest(requestId);
				if (!req) continue;
				// 先放行 agent 再持久化（D3）：持久化失败（如 workspaces.json 损坏拒写）只丢记忆不挂会话，
				// log.error 留痕——fail-open 与 enabled=false 整体放行的既有语义一致
				gate.respond(requestId, answer);
				this.permissionResolvedEmitter.emit({
					sessionId: gate.getSessionId(),
					requestId,
					answered: true,
				});
				const entry = this.registry.get(gate.getSessionId());
				if (entry) {
					try {
						const agentDir = getAgentDir();
						if (answer === "allowDir" && req.meta?.suggestDir) {
							addWorkspaceRoot(agentDir, entry.cwd, req.meta.suggestDir);
						} else if (answer === "allowAlways" && req.meta) {
							addAllowedPattern(agentDir, entry.cwd, req.title);
						}
					} catch (err) {
						log.error("权限决策持久化失败（agent 已放行，本次决策不记忆）", requestId, err);
					}
				}
				return;
			}
			return;
		}
		for (const { gate } of this.registry.list()) {
			if (!gate.getRequest(requestId)) continue;
			gate.respond(requestId, answer);
			this.permissionResolvedEmitter.emit({
				sessionId: gate.getSessionId(),
				requestId,
				answered: true,
			});
		}
	}

	/** 权限门控配置（enabled 解析保留；UI 已无开关入口，仅手改 permissions.json 可关 = 隐藏逃生舱） */
	getPermissionConfig(): { enabled: boolean } {
		return { enabled: loadPermissionConfig(getAgentDir()).enabled };
	}

	/** 会话权限模式（default 缺省 fail-safe；关 tab 重开后端已归零，renderer 对齐用） */
	getSessionPermissionMode(sessionId: string): PermissionMode {
		return this.registry.get(sessionId)?.modeRef.current ?? "default";
	}

	/** 切换会话权限模式（内存态即时生效，不落盘；会话不存在时抛可读错误） */
	setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
		const entry = this.registry.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		entry.modeRef.current = mode;
		log.info("permission mode", sessionId, { mode });
	}

	/** 上下文管理模式（二态：evaporation / off；单一 key 派生读，缺省蒸发） */
	getContextManagerConfig(): { mode: ContextManagerMode } {
		return { mode: readContextManagerMode(getAgentDir()) };
	}

	/** 写上下文管理模式（单一写者原子写，写后即效：下一轮 context 钩子见新值）。损坏拒写时上抛 */
	setContextManagerMode(mode: ContextManagerMode): void {
		try {
			writeContextManagerMode(getAgentDir(), mode);
		} catch (err) {
			log.error("settings.json 写入失败（contextManager mode 未保存）", err);
			throw err; // ipcMain.handle，reject 传回 renderer
		}
		log.info("context manager mode", mode);
	}

	/** channel-watch 总开关（设置 UI 用；键在 ~/.pi/agent/settings.json，缺省=开） */
	getChannelWatchConfig(): { enabled: boolean } {
		return { enabled: readChannelWatchEnabled(getAgentDir()) };
	}

	/** 写 channel-watch 开关（下一 session_start 生效：目录 init/watcher/工具注册全部跟随）。损坏拒写时上抛 */
	setChannelWatchEnabled(enabled: boolean): void {
		try {
			writeChannelWatchEnabled(getAgentDir(), enabled);
		} catch (err) {
			log.error("settings.json 写入失败（channel-watch 开关未保存）", err);
			throw err; // ipcMain.handle，reject 传回 renderer
		}
		log.info("channel watch enabled", enabled);
	}

	respondTrust(requestId: string, answer: TrustAnswer): void {
		this.trustGate.respond(requestId, answer);
	}

	dispose(): void {
		this.registry.disposeAll();
		this.eventEmitter.clear();
		this.permissionEmitter.clear();
		this.permissionResolvedEmitter.clear();
		this.trustEmitter.clear();
		this.loginEmitter.clear();
		this.extensionDialogRequestEmitter.clear();
		this.extensionDialogResolvedEmitter.clear();
		this.extensionNotifyEmitter.clear();
		this.extensionEditorTextEmitter.clear();
		this.trustGate.dispose();
		this.traces.disposeAll();
		log.info("backend disposed");
	}

	private requireSession(sessionId: string) {
		const entry = this.registry.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		return entry;
	}

	/** 只读会话（subagent 产物检视）写操作统一守卫；可写时返回 entry */
	private requireWritable(sessionId: string) {
		const entry = this.requireSession(sessionId);
		if (entry.readOnly) throw new Error("Session is read-only (subagent transcript)");
		return entry;
	}

	private toMetaOrThrow(sessionId: string): SessionMeta {
		const entry = this.registry.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		return this.registry.toMeta(entry);
	}
}

export type { EventForwarder, Model };
