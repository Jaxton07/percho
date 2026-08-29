import type { LanSseFrame, LanTranscript } from "@percho/shared";
import { create } from "zustand";
import {
	applyFrame,
	initialLanState,
	type LanAppState,
	ORPHAN_BOUNDARY_TYPES,
	seedSessions,
	seedTranscript,
} from "./store-pure";

export type { LanAppState } from "./store-pure";

const TOKEN_KEY = "percho-lan-token";

interface LanStore extends LanAppState {
	/** 401 → 清 token 回输入页，并置 authFailed（TokenGate 展示「令牌无效」）。 */
	logout: () => void;
	setToken: (token: string) => void;
	select: (sessionId: string | null) => void;
	/** 历史会话按需拉 transcript（无种子时由 ChatView 触发）。 */
	loadTranscript: (sessionId: string) => Promise<void>;
	/** M2 写操作。返回 null = 成功，string = 错误提示。401 自动 logout。 */
	sendPrompt: (sessionId: string, text: string) => Promise<string | null>;
	abortSession: (sessionId: string) => Promise<string | null>;
	respondPermission: (requestId: string, answer: "allowOnce" | "deny") => Promise<string | null>;
}

export const useLanStore = create<LanStore>((set) => ({
	...initialLanState,
	token: new URLSearchParams(location.search).get("t") ?? localStorage.getItem(TOKEN_KEY) ?? "",
	logout: () => {
		localStorage.removeItem(TOKEN_KEY);
		set({ ...initialLanState, token: "", status: "token", authFailed: true });
		connect();
	},
	setToken: (token) => {
		localStorage.setItem(TOKEN_KEY, token);
		set({ token, authFailed: false });
		connect();
	},
	select: (selected) => set({ selected }),
	loadTranscript: async (sessionId) => {
		const token = useLanStore.getState().token;
		try {
			const res = await fetch(
				`/api/sessions/${encodeURIComponent(sessionId)}/transcript?t=${encodeURIComponent(token)}`,
				{ cache: "no-store" },
			);
			if (res.status === 401) {
				useLanStore.getState().logout();
				return;
			}
			if (!res.ok) return;
			const entry = (await res.json()) as LanTranscript;
			useLanStore.setState((state) => seedTranscript(state, entry));
		} catch {
			// 网络失败：保持「加载中」，下次进入会话重试
		}
	},
	sendPrompt: async (sessionId, text) => {
		const res = await postApi(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { text });
		return res;
	},
	abortSession: async (sessionId) => {
		const res = await postApi(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {});
		return res;
	},
	respondPermission: async (requestId, answer) => {
		const res = await postApi(`/api/permissions/${encodeURIComponent(requestId)}/respond`, { answer });
		return res;
	},
}));

/** POST 写端点：Authorization: Bearer（不依赖 ?t=，token 不进 URL 日志）。 */
async function postApi(path: string, body: unknown): Promise<string | null> {
	try {
		const res = await fetch(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${useLanStore.getState().token}`,
			},
			body: JSON.stringify(body),
		});
		if (res.status === 401) {
			useLanStore.getState().logout();
			return null;
		}
		if (!res.ok) {
			const data = (await res.json().catch(() => null)) as { error?: string } | null;
			return data?.error ?? `error ${res.status}`;
		}
		return null;
	} catch {
		return "network error";
	}
}

let stream: EventSource | null = null;
let snapshotInFlight = false;
/** 快照种子完成前到达的帧缓冲（seed 后按 seq 过滤回放）。 */
let preSeedFrames: LanSseFrame[] = [];
/** 未知会话活动触发的快照重拉防抖（服务端种子竞态自愈，见 IMPL-NOTES 阶段 4）。 */
let refetchScheduled = false;
/** 快照重拉最小间隔（unknown 会话自愈风暴防护；immediate 边界帧不受限） */
let lastRefetchAt = 0;
const REFETCH_MIN_INTERVAL_MS = 2500;
/** 最近一次收到任意帧（含 ping 心跳）的时刻；watchdog 判活数据源。 */
let lastFrameAt = 0;
/** 心跳静默超时：超过则判定半开连接，主动断开重连（服务端 PING_MS = 20s） */
const STALE_MS = 50_000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
/** 状态迟滞：onerror 后延迟多久才把药丸切成「重连中」（期间 EventSource 自动重连大概率已成功） */
const RECONNECT_LABEL_DELAY_MS = 3000;
let reconnectLabelTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前连接是否经历过断线（决定 onopen 时是否需要重拉快照：断线期间帧丢失，靠快照补齐） */
let needsRefetchOnOpen = false;

async function fetchSnapshot(): Promise<void> {
	const token = useLanStore.getState().token;
	try {
		const res = await fetch(`/api/snapshot?t=${encodeURIComponent(token)}`, { cache: "no-store" });
		if (res.status === 401) {
			useLanStore.getState().logout();
			return;
		}
		if (!res.ok) throw new Error(`snapshot ${res.status}`);
		const snap = await res.json();
		useLanStore.setState((state) => seedSessions(state, snap));
		// 种子完成：回放缓冲帧（applyFrame 内部按 snapshotSeq 去重）
		const buffered = preSeedFrames;
		preSeedFrames = [];
		for (const frame of buffered) useLanStore.setState((state) => applyFrame(state, frame));
	} finally {
		// 失败也必须复位：否则 snapshotInFlight 永久卡 true，后续所有帧只缓冲不应用（页面冻结）
		snapshotInFlight = false;
	}
}

function onFrame(frame: LanSseFrame): void {
	if (snapshotInFlight || !useLanStore.getState().seeded) {
		preSeedFrames.push(frame);
		return;
	}
	// 服务端尚未种子该会话（重连/新会话竞态）就来了活动帧 → 调度快照重拉自愈
	const sessionId =
		frame.event === "view" || frame.event === "event" || frame.event === "perm" ? frame.data.sessionId : null;
	if (sessionId && !useLanStore.getState().transcripts[sessionId]) {
		scheduleSnapshotRefetch();
		return;
	}
	// 中途进入自愈：streamHealing 态下到达 run 提交/终态边界 → 立即重拉快照取回已提交消息
	if (frame.event === "event" && sessionId && ORPHAN_BOUNDARY_TYPES.has(frame.data.event.type)) {
		const state = useLanStore.getState();
		if (state.streamHealing[sessionId] != null && !state.transcripts[sessionId]?.streaming) {
			scheduleSnapshotRefetch({ immediate: true });
		}
	}
	useLanStore.setState((state) => applyFrame(state, frame));
}

function scheduleSnapshotRefetch(opts?: { immediate?: boolean }): void {
	if (refetchScheduled || snapshotInFlight) return;
	refetchScheduled = true;
	const wait = opts?.immediate ? 0 : Math.max(300, REFETCH_MIN_INTERVAL_MS - (Date.now() - lastRefetchAt));
	setTimeout(() => {
		refetchScheduled = false;
		if (snapshotInFlight) return;
		snapshotInFlight = true;
		preSeedFrames = [];
		lastRefetchAt = Date.now();
		void fetchSnapshot().catch(() => {});
	}, wait);
}

/** 建立/重建 SSE 连接（token 变化、logout、watchdog 判死时调用）。无 token 时停在输入页。 */
export function connect(): void {
	stream?.close();
	stream = null;
	cancelReconnectLabel();
	const token = useLanStore.getState().token;
	if (!token) {
		useLanStore.setState({ status: "token" });
		stopWatchdog();
		return;
	}
	useLanStore.setState({ status: "connecting" });
	snapshotInFlight = true;
	preSeedFrames = [];
	lastFrameAt = Date.now();
	void fetchSnapshot().catch(() => useLanStore.setState({ status: "reconnecting" }));
	stream = new EventSource(`/api/stream?t=${encodeURIComponent(token)}`);
	stream.onopen = () => {
		lastFrameAt = Date.now();
		cancelReconnectLabel();
		useLanStore.setState({ status: "connected" });
		// 断线重连才重拉快照（断线期间的帧永久丢失，快照是唯一补齐手段）；
		// 首次连接 connect() 已拉过，跳过避免双拉
		if (needsRefetchOnOpen && !snapshotInFlight) {
			snapshotInFlight = true;
			preSeedFrames = [];
			void fetchSnapshot().catch(() => {});
		}
		needsRefetchOnOpen = false;
	};
	stream.onerror = () => {
		// 移动端切网/锁屏/切后台时 OS 杀长连接是常态，EventSource 自动重连通常秒级成功；
		// 延迟切「重连中」避免药丸闪烁，连上则取消（首连失败也走同一条路径 connecting→reconnecting）
		needsRefetchOnOpen = true;
		if (reconnectLabelTimer) return;
		reconnectLabelTimer = setTimeout(() => {
			reconnectLabelTimer = null;
			useLanStore.setState((state) =>
				state.status === "connected" || state.status === "connecting" ? { status: "reconnecting" } : {},
			);
		}, RECONNECT_LABEL_DELAY_MS);
	};
	for (const name of ["view", "list", "event", "perm", "perm_resolved", "ping"] as const) {
		stream.addEventListener(name, (e) => {
			lastFrameAt = Date.now();
			if (name === "ping") return;
			try {
				onFrame({ event: name, data: JSON.parse((e as MessageEvent).data) } as LanSseFrame);
			} catch {
				// 坏帧忽略，重连快照兜底
			}
		});
	}
	startWatchdog();
}

/** 心跳 watchdog：连接打开但超时无任何帧（含 ping）→ 判定半开连接，主动断开重建。 */
function startWatchdog(): void {
	stopWatchdog();
	watchdogTimer = setInterval(() => {
		if (!stream || useLanStore.getState().status !== "connected") return;
		if (Date.now() - lastFrameAt > STALE_MS) {
			// 状态切 connecting + 主动重连（服务端 20s 心跳不可达即已死，不必等 TCP 超时）
			useLanStore.setState({ status: "connecting" });
			connect();
		}
	}, 5000);
}

function stopWatchdog(): void {
	if (watchdogTimer) clearInterval(watchdogTimer);
	watchdogTimer = null;
}

function cancelReconnectLabel(): void {
	if (reconnectLabelTimer) {
		clearTimeout(reconnectLabelTimer);
		reconnectLabelTimer = null;
	}
}
