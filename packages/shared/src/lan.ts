import type { PermissionRequest, SessionMessage } from "./session";
import type { TodoItem } from "./todo";

/** 局域网观察服务的持久化配置（token 在每次启用时轮换）。 */
export interface LanObserverConfig {
	enabled: boolean;
	/** 期望监听端口；端口被占用时实际端口见 LanStatus。 */
	port: number;
	token: string | null;
	/** M2 远程控制二级开关（默认 false；开观察 ≠ 开控制）。旧配置缺此字段视为 false。 */
	remoteControl: boolean;
}

/** 局域网观察服务的运行状态（供设置页显示）。 */
export interface LanStatus {
	enabled: boolean;
	/** 实际监听端口；未监听时为 null。 */
	port: number | null;
	/** 各网卡 IPv4 的完整观察 URL（含 token）。 */
	urls: string[];
	/** 首选 URL 的二维码 data URL。 */
	qrDataUrl: string | null;
	/** 当前 SSE 连接数。 */
	clients: number;
	/** M2 远程控制开关运行态（客户端据此显隐 composer/审批按钮）。 */
	remoteControl: boolean;
}

/** 会话列表项；历史会话只暴露此投影，不提供详情。 */
export interface LanSessionBrief {
	sessionId: string;
	name: string;
	cwd: string;
	active: boolean;
	modifiedAt: number;
}

/** 手机观察页使用的单个活跃会话只读投影。 */
export interface LanSessionView {
	sessionId: string;
	name: string;
	cwd: string;
	agentActive: boolean;
	compacting: boolean;
	queued: boolean;
	currentTool: string | null;
	assistantTail: string | null;
	todos: TodoItem[];
	pendingPermission: { title: string; message: string; kind: string } | null;
	lastError: string | null;
	stats: { inputTokens: number; outputTokens: number; cost: number } | null;
	lastActivity: number;
}

/** SSE 初始握手帧。 */
export interface LanSseHelloFrame {
	event: "hello";
	data: { seq: number };
}

/** SSE 单会话全量投影视图帧。 */
export interface LanSseViewFrame {
	event: "view";
	data: { sessionId: string; view: LanSessionView; seq: number };
}

/** SSE 会话列表帧。 */
export interface LanSseListFrame {
	event: "list";
	data: { list: LanSessionBrief[]; seq: number };
}

/** SSE 会话事件转发帧（V2 新增；event 已 sanitize，仅活跃会话）。 */
export interface LanSseEventFrame {
	event: "event";
	data: { sessionId: string; event: import("./session").SessionEvent; seq: number };
}

/** SSE 权限请求帧（V2 新增；request 含 requestId 供远程应答）。 */
export interface LanSsePermFrame {
	event: "perm";
	data: { sessionId: string; request: PermissionRequest; seq: number };
}

/** SSE 权限已应答帧（V2 新增；客户端据此清除权限卡）。 */
export interface LanSsePermResolvedFrame {
	event: "perm_resolved";
	data: { sessionId: string; requestId: string; answered: boolean; seq: number };
}

/** 局域网观察服务的所有 SSE 数据帧。 */
export type LanSseFrame =
	| LanSseHelloFrame
	| LanSseViewFrame
	| LanSseListFrame
	| LanSseEventFrame
	| LanSsePermFrame
	| LanSsePermResolvedFrame;

/** snapshot 中单会话的历史消息投影（sanitize 后）。 */
export interface LanTranscript {
	sessionId: string;
	/** sanitize 后的历史消息，尾部 cap 100 条。 */
	messages: SessionMessage[];
	/** 被 cap 截断 = true（客户端显示「仅显示最近消息」）。 */
	truncated: boolean;
}

/** GET /api/snapshot 响应（V2 扩展：+ transcripts 与 remoteControl）。 */
export interface LanSnapshot {
	serverTime: number;
	list: LanSessionBrief[];
	views: LanSessionView[];
	transcripts: LanTranscript[];
	remoteControl: boolean;
}

/** M2 POST /api/sessions/:id/prompt 请求体。 */
export interface LanPromptBody {
	text: string;
}

/** M2 POST /api/permissions/:id/respond 请求体（远程只允许允许一次/拒绝）。 */
export interface LanRespondBody {
	answer: "allowOnce" | "deny";
}

/** M2 写端点统一成功响应。 */
export interface LanWriteResult {
	ok: true;
}
