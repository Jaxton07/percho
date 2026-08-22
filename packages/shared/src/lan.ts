import type { TodoItem } from "./todo";

/** 局域网观察服务的持久化配置（token 在每次启用时轮换）。 */
export interface LanObserverConfig {
	enabled: boolean;
	/** 期望监听端口；端口被占用时实际端口见 LanStatus。 */
	port: number;
	token: string | null;
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

/** 局域网观察服务的所有 SSE 数据帧。 */
export type LanSseFrame = LanSseHelloFrame | LanSseViewFrame | LanSseListFrame;
