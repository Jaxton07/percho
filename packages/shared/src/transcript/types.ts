import type { UiError } from "../errors";
import type { ImageInput } from "../session";
import type { SkillInvocationDisplay } from "../skill-invocation";
import type { TodoItem } from "../todo";

/** SDK 自动重试（auto_retry_start）即时信息：状态行文案 + 出现/清除时机都来自事件流 */
export interface RetryInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}

/** 会话 UI 态类型（transcript reducer 的状态形状） */

/** 子代理运行（UI 态：流式期 running，固化后 done/error） */
export interface SubagentRunUi {
	/** 本地稳定标识（React key 用） */
	key: string;
	agent: string;
	task?: string;
	status: "running" | "done" | "error";
	model?: string;
	tokens?: number;
	exitCode?: number;
	artifactsDir?: string;
	/** 子代理会话文件路径（点击打开完整对话） */
	sessionFile?: string;
}

/** 单条 UI 消息 */
export type UIMessage =
	| {
			kind: "user";
			id: string;
			text: string;
			images: ImageInput[];
			timestamp: number;
			/** 会话树 entry id（仅历史回放消息有；撤回精确定位，缺省时按文本+时间戳兑底） */
			entryId?: string;
			/** 已展开 skill 的安全展示信息（不含正文或路径） */
			skill?: SkillInvocationDisplay;
			/** 完整持久化文本（skill 展开或展示净化后保留），仅供撤回匹配；绝不能渲染、复制或进入可访问文本 */
			sourceText?: string;
	  }
	| {
			kind: "assistant";
			id: string;
			text: string;
			thinking: string;
			tools: UIToolCall[];
			timestamp: number;
			/** 会话树 entry id（仅历史回放消息有；fork 精确定位，缺省时 fork 按正文文本兜底） */
			entryId?: string;
			/** 完整持久化正文（展示净化后保留），仅供 fork fallback 匹配；绝不能渲染、复制或进入可访问文本 */
			sourceText?: string;
	  }
	| {
			/** 错误卡（live 与历史回放共用的统一报错信封；派生消息，不持久化 — text 恒为空串，渲染走 error） */
			kind: "error";
			id: string;
			text: string;
			timestamp: number;
			error: UiError;
	  }
	| {
			kind: "system";
			id: string;
			text: string;
			timestamp: number;
			compact?: CompactionUiState;
			/** subagent 互斥接管通知（结构化字段，渲染层 i18n；dedup 以 extensionPath 为准） */
			mutex?: { extensionPath: string; tools: string[] };
	  }
	| {
			/** show_image 工具发给用户看的图片（assistant 侧独立消息，tool_execution_end 时立即落 messages） */
			kind: "image";
			id: string;
			images: ImageInput[];
			paths: string[];
			timestamp: number;
	  }
	| {
			/** subagent 工具调用（独立行，不收进工具折叠区；流式期 running，固化后 done/error） */
			kind: "subagent";
			id: string;
			runs: SubagentRunUi[];
			timestamp: number;
	  };

/** 上下文压缩系统消息状态（compaction_start → compaction_end 更新同一条） */
export interface CompactionUiState {
	status: "running" | "done" | "cancelled" | "error";
	reason: "manual" | "threshold" | "overflow";
	summary?: string;
	tokensBefore?: number;
	tokensAfter?: number;
	errorMessage?: string;
}

/** 工具调用卡片状态 */
export interface UIToolCall {
	/** 本地稳定标识（React key 用）：创建时分配，不随 toolcall_end 改写（id 会从 "" 翻转为真实 id） */
	key: string;
	id: string;
	name: string;
	/** 参数摘要（JSON 或纯文本） */
	args: string;
	/** 执行输出累积 */
	output: string;
	/** unified patch（仅 edit 工具成功时由 SDK details.patch 写入；write/其他工具无此字段） */
	diff?: string;
	state: "running" | "done" | "error";
	/** content 块绝对索引（toolcall_start 时记录）：与 StreamingState.textBlockIndex 比较判定「正文前/正文后」，
	 * 保住同 turn 内 text→toolCall 交错的时序；历史回放消息由 backend 预拆分，不带此字段 */
	blockIndex?: number;
}

/** 预览活动条目：事件流按首次到达顺序追加，只服务 live preview，不写入历史。 */
export type ActivityEntry =
	/** 按 content block 拆分，避免 think → tool → think 复用固定身份。 */
	| { id: string; kind: "thinking"; text: string }
	/** 工具参数随 delta 累积，toolcall_end 用最终规范参数覆盖。 */
	| { id: string; kind: "tool"; name: string; args: string };

/** 进行中的流式累积 */
export interface StreamingState {
	/** 消息 id：容器创建时预生成，turn_end 固化时复用同一个 id —— 流式与固化后的 MessageItem key 一致，
	 * 组件不 remount，Markdown 的平滑输出 controller 得以存活续播（否则固化瞬间平滑被打断、整段跳变） */
	id: string;
	text: string;
	thinking: string;
	tools: UIToolCall[];
	/** show_image 发图缓冲：tool_execution_end 先入缓冲，turn_end 固化时排在 assistant 消息之后（与历史回放顺序一致） */
	pendingImages: { images: ImageInput[]; paths: string[] }[];
	/** 子代理运行缓冲：tool_execution_start 建占位（工作中），end 用 details 完善，turn_end 固化为独立消息 */
	subagentRuns: SubagentRunUi[];
	/** toolCallId → subagentRuns 起点与占位数（parallel 一次调用可对应多行） */
	subagentByToolCallId: Record<string, { start: number; count: number }>;
	/** 最近一次 toolcall_start 的工具索引 */
	activeToolIndex: number;
	/** assistant 消息 content 绝对索引 → tools 数组索引（事件带 contentIndex，须按此匹配） */
	toolByContentIndex: Record<number, number>;
	/** toolCallId → 原始 output delta 累积，仅用于每次重算 display output；绝不能交给渲染层 */
	rawToolOutputs?: Record<string, string>;
	/** 到达顺序的活动序列（thinking / tool call 穿插），预览行数据源 */
	activity: ActivityEntry[];
	/** 首个 text 块的 contentIndex（正文起点锚）；null = 本 turn 尚无正文。同 turn 的工具按
	 * blockIndex 与之比较分「正文前/正文后」——否则平铺模型会把正文后的工具（如
	 * “任务完成，清空列表”+todo clear）倒挂到正文上方并进前一个折叠组，时序反转 */
	textBlockIndex: number | null;
}

export type SessionPhase = "idle" | "streaming" | "awaiting_permission";

export interface SessionTranscriptState {
	messages: UIMessage[];
	streaming: StreamingState | null;
	phase: SessionPhase;
	/** agent 运行中（用户发消息后 → 下一次正文回复间为 true，agent 结束/中止为 false） */
	agentActive: boolean;
	/** 后台会话完成未读（agentActive true→false 时该会话未被查看则置 true；查看/重新开工清除）。reducer 不维护，由 store 层按 isActiveViewing 处理 */
	unseenCompletion: boolean;
	/** 运行中排队的 followUp 消息文本（SDK queue_update 事件整组替换；agent 完成自动投递后清空） */
	followUpQueue: string[];
	/** 上下文压缩进行中（compaction_start/end 驱动；期间禁发——SDK 拒绝压缩中的 prompt，前端提前拦截保草稿） */
	compacting: boolean;
	/** todo 工具维护的任务列表（跨 turn 存活；compaction 后由 loadTodos 从 backend 恢复） */
	todos: TodoItem[];
	/** 本轮 turn_end 已见 LLM 错误但尚未确定是否落卡（agent_end willRetry=true → 丢弃；false → 落卡
	 * —— SDK 每个 retry 轮都发 turn_end(error)，立即落卡会在重试场景产多张卡且成功后残留，
	 * 违背「只有最终失败才落卡」）。清空时机：agent_end/agent_settled/stream_guard_tripped。 */
	pendingLlmError: UiError | null;
	/** SDK 自动重试瞬时信息（auto_retry_start → 状态行；auto_retry_end/turn_start/agent_settled 清） */
	retrying: RetryInfo | null;
}

export function emptyTranscript(): SessionTranscriptState {
	return {
		messages: [],
		streaming: null,
		phase: "idle",
		agentActive: false,
		unseenCompletion: false,
		followUpQueue: [],
		compacting: false,
		todos: [],
		pendingLlmError: null,
		retrying: null,
	};
}
