import type { LanSseFrame } from "@percho/shared";
import { create } from "zustand";
import { applyFrame, initialLanState, type LanAppState, seedSessions } from "./store-pure";

export type { LanAppState } from "./store-pure";

const TOKEN_KEY = "percho-lan-token";

interface LanStore extends LanAppState {
	/** 401 → 清 token 回输入页 */
	logout: () => void;
	setToken: (token: string) => void;
	select: (sessionId: string | null) => void;
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
		set({ ...initialLanState, token: "", status: "token" });
		connect();
	},
	setToken: (token) => {
		localStorage.setItem(TOKEN_KEY, token);
		set({ token });
		connect();
	},
	select: (selected) => set({ selected }),
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

async function fetchSnapshot(): Promise<void> {
	const token = useLanStore.getState().token;
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
	snapshotInFlight = false;
	for (const frame of buffered) useLanStore.setState((state) => applyFrame(state, frame));
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
	useLanStore.setState((state) => applyFrame(state, frame));
}

function scheduleSnapshotRefetch(): void {
	if (refetchScheduled || snapshotInFlight) return;
	refetchScheduled = true;
	setTimeout(() => {
		refetchScheduled = false;
		if (snapshotInFlight) return;
		snapshotInFlight = true;
		preSeedFrames = [];
		void fetchSnapshot().catch(() => {});
	}, 300);
}

/** 建立/重建 SSE 连接（token 变化、logout 时调用）。无 token 时停在输入页。 */
export function connect(): void {
	stream?.close();
	stream = null;
	const token = useLanStore.getState().token;
	if (!token) {
		useLanStore.setState({ status: "token" });
		return;
	}
	useLanStore.setState({ status: "connecting" });
	snapshotInFlight = true;
	preSeedFrames = [];
	void fetchSnapshot().catch(() => useLanStore.setState({ status: "reconnecting" }));
	stream = new EventSource(`/api/stream?t=${encodeURIComponent(token)}`);
	stream.onopen = () => {
		useLanStore.setState({ status: "connected" });
		// 每次（重）连都重拉快照：幂等自愈（spec：snapshot 为权威）
		if (!snapshotInFlight) {
			snapshotInFlight = true;
			preSeedFrames = [];
			void fetchSnapshot().catch(() => {});
		}
	};
	stream.onerror = () => {
		useLanStore.setState((state) => (state.status === "token" ? state : { status: "reconnecting" }));
	};
	for (const name of ["view", "list", "event", "perm", "perm_resolved"] as const) {
		stream.addEventListener(name, (e) => {
			try {
				onFrame({ event: name, data: JSON.parse((e as MessageEvent).data) } as LanSseFrame);
			} catch {
				// 坏帧忽略，重连快照兜底
			}
		});
	}
}
