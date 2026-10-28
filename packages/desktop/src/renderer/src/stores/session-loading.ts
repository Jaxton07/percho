import type { PermissionMode, SessionMeta } from "@percho/shared";
import { environmentEntityRef, messagesToUIMessages } from "@percho/shared";
import { getExecutionApi } from "../environment-api";
import { errText } from "../lib/error-text";
import {
	beginSessionBaseline,
	failSessionBaseline,
	finishSessionBaseline,
	isCurrentSessionBaseline,
} from "./session-event-boundary";
import {
	clearSessionHistory,
	deferSessionHistory,
	finishSessionHistory,
	historyOpenEpoch,
	isHistoryReady,
} from "./session-history";
import { pushToast } from "./toasts";
import { useTranscriptStore } from "./transcript";
import { useUiPreferencesStore } from "./ui-preferences";

export interface SessionDataPorts {
	isOpen(sessionId: string): boolean;
	landMeta(meta: SessionMeta): void;
	readPermissionMode(sessionId: string): PermissionMode | undefined;
	writePermissionMode(sessionId: string, mode: PermissionMode): void;
}

/** Data loading only: each instance owns file/session flights, never navigation or drafts. */
export function createSessionLoader(ports: SessionDataPorts) {
	/** 同会话在途的 bundle 装载（key = sessionId） */
	const bundleInFlight = new Map<string, Promise<void>>();

	/**
	 * 打开会话时同步四件套：消息历史（可选跳过 live 态）、排队队列、todo 面板、权限模式。
	 * 取数并行（各写 store 不同字段，无交叉读），应用顺序保持 history → queue → todos。
	 * 权限模式对齐后端真值：关 tab 重开后端已归零 default，拉回防 stale（spec permission-mode D1）。
	 *
	 * 同会话同时在途时复用同一个 Promise（spec D3，见 `ensureOpenSession`）：open 完成时 meta 会先落进
	 * `sessions`，用户这时再点那一行就走 `switchSession` 的懒加载，两条路会撞车重复拉四件套。
	 */
	function loadSessionBundle(sessionId: string, opts?: { skipHistoryIfLive?: boolean }): Promise<void> {
		const existing = bundleInFlight.get(sessionId);
		if (existing) return existing;
		const openingEpoch = historyOpenEpoch(sessionId);
		const promise = loadSessionBundleInner(sessionId, opts)
			.catch((error: unknown) => {
				// 历史 IPC 失败也不能把「有一条实时消息」当作历史完成。保留可重试状态。
				if (
					historyOpenEpoch(sessionId) === openingEpoch &&
					!isHistoryReady(sessionId) &&
					environmentEntityRef(sessionId).environment.kind === "local" &&
					ports.isOpen(sessionId)
				) {
					deferSessionHistory(sessionId, () => ports.isOpen(sessionId));
				}
				throw error;
			})
			.finally(() => {
				if (bundleInFlight.get(sessionId) === promise) bundleInFlight.delete(sessionId);
			});
		bundleInFlight.set(sessionId, promise);
		return promise;
	}

	async function loadSessionBundleInner(
		sessionId: string,
		opts?: { skipHistoryIfLive?: boolean },
	): Promise<void> {
		if (environmentEntityRef(sessionId).environment.kind === "ssh") {
			const openingEpoch = historyOpenEpoch(sessionId);
			const token = beginSessionBaseline(sessionId);
			try {
				const baseline = await getExecutionApi(sessionId).getSessionBaseline({ sessionId });
				if (
					historyOpenEpoch(sessionId) !== openingEpoch ||
					!ports.isOpen(sessionId) ||
					!isCurrentSessionBaseline(sessionId, token)
				)
					return;
				finishSessionBaseline(sessionId, token, baseline.sequence, () => {
					const previous = useTranscriptStore.getState().bySession[sessionId];
					useTranscriptStore.setState((state) => ({
						bySession: {
							...state.bySession,
							[sessionId]: {
								...baseline.transcript,
								phase: previous?.pendingPermissions.length
									? "awaiting_permission"
									: baseline.transcript.phase,
								pendingPermissions: previous?.pendingPermissions ?? [],
								pendingDialogs: previous?.pendingDialogs ?? [],
							},
						},
					}));
					ports.landMeta(baseline.meta);
					ports.writePermissionMode(sessionId, baseline.permissionMode);
				});
				finishSessionHistory(sessionId);
			} catch (error) {
				failSessionBaseline(sessionId, token);
				throw error;
			}
			return;
		}
		// skip 判定在入口一次性取值：并行发起 IPC 前先确定是否跳过历史（agent 运行中保流式态，见 openFromHistory 注释）
		const skipHistory =
			opts?.skipHistoryIfLive === true &&
			useTranscriptStore.getState().bySession[sessionId]?.agentActive === true;
		const transcriptBefore = useTranscriptStore.getState().bySession[sessionId];
		const openingEpoch = historyOpenEpoch(sessionId);
		const [history, followUpQueue, todos, permissionMode, loaded] = await Promise.all([
			skipHistory ? Promise.resolve(null) : getExecutionApi(sessionId).getSessionMessages({ sessionId }),
			getExecutionApi(sessionId).getFollowUpMessages({ sessionId }),
			getExecutionApi(sessionId).getTodos({ sessionId }),
			getExecutionApi(sessionId).getPermissionMode({ sessionId }),
			getExecutionApi(sessionId).getLoadedSessions(),
		]);
		// TOCTOU 复核：await 期间会话转为 live（如恰好有 prompt 竞态）时丢弃迟到历史，
		// 防旧快照覆盖刚建立的流式态（queue/todo/permissionMode 是幂等快照，照常应用）
		const transcriptNow = useTranscriptStore.getState().bySession[sessionId];
		const liveNow = transcriptNow?.agentActive === true;
		// 不能只看 liveNow：IPC 期间恰好跑完的一轮可能已改写 transcript，旧快照仍过期。
		// 关闭后的迟到 bundle 也绝不能重建该 session 的 UI 条目。
		if (historyOpenEpoch(sessionId) !== openingEpoch || !ports.isOpen(sessionId)) return;
		const t = useTranscriptStore.getState();
		const historyNeedsRetry = !history || liveNow || transcriptBefore !== transcriptNow;
		if (history && !historyNeedsRetry) {
			t.loadHistory(sessionId, messagesToUIMessages(history));
			finishSessionHistory(sessionId);
		}
		t.setFollowUpQueue(sessionId, followUpQueue);
		t.loadTodos(sessionId, todos);
		// 本机历史回放不携带实例运行态；只在读取期间没有新事件时采纳权威暂停值。
		if (transcriptBefore === transcriptNow) {
			const pause = loaded.find((summary) => summary.meta.sessionId === sessionId)?.compactionPause ?? null;
			useTranscriptStore.setState((state) => {
				const current = state.bySession[sessionId];
				return current
					? { bySession: { ...state.bySession, [sessionId]: { ...current, compactionPause: pause } } }
					: state;
			});
		}
		ports.writePermissionMode(sessionId, permissionMode);
		if (historyNeedsRetry) {
			deferSessionHistory(sessionId, () => ports.isOpen(sessionId));
		}
		// D7：本机记住过的档位盖过后端默认值（后端 mode 不落盘，重启/卸载重开后恒为 default）。
		// 这里 await 而不是 fire-and-forget：保证「打开完就是正确档位」，验收才能确定性断言。
		const remembered =
			environmentEntityRef(sessionId).environment.kind === "local"
				? useUiPreferencesStore.getState().sessionPermissionModes[sessionId]
				: undefined;
		if (remembered && remembered !== permissionMode) {
			try {
				await getExecutionApi(sessionId).setPermissionMode({ sessionId, mode: remembered });
				if (historyOpenEpoch(sessionId) === openingEpoch && ports.isOpen(sessionId)) {
					ports.writePermissionMode(sessionId, remembered);
				}
			} catch (error) {
				console.warn("恢复会话权限模式失败", error);
			}
		}
	}

	/** GC重建后恢复renderer档位；有效失败回落backend default并提示，持久偏好留待下次重试。 */
	async function restorePermissionMode(sessionId: string): Promise<void> {
		const openingEpoch = historyOpenEpoch(sessionId);
		if (environmentEntityRef(sessionId).environment.kind !== "local") return;
		const mode = ports.readPermissionMode(sessionId);
		if (!mode || mode === "default") return;
		try {
			await getExecutionApi(sessionId).setPermissionMode({ sessionId, mode });
		} catch (error) {
			console.warn("恢复会话权限模式失败", error);
			if (historyOpenEpoch(sessionId) !== openingEpoch || !ports.isOpen(sessionId)) return;
			ports.writePermissionMode(sessionId, "default");
			pushToast("warning", "toast.permissionModeFailed", errText(error));
		}
	}

	/** 按trim后的file单飞，失败一次提示且可重试；GC loadBundle:false保留现有transcript。 */
	function ensureOpenSession(filePath: string, opts?: { loadBundle?: boolean }): Promise<SessionMeta | null> {
		const key = filePath.trim();
		const existing = openInFlight.get(key);
		if (existing) return existing;
		const promise: Promise<SessionMeta | null> = ensureOpenSessionInner(
			key,
			opts?.loadBundle !== false,
			() => openInFlight.get(key) === promise,
		).finally(() => {
			if (openInFlight.get(key) === promise) openInFlight.delete(key);
		});
		openInFlight.set(key, promise);
		return promise;
	}

	const openInFlight = new Map<string, Promise<SessionMeta | null>>();

	async function ensureOpenSessionInner(
		filePath: string,
		loadBundle: boolean,
		isCurrent: () => boolean,
	): Promise<SessionMeta | null> {
		let meta: SessionMeta;
		try {
			meta = await getExecutionApi(filePath).openSession({ filePath });
		} catch (error) {
			console.error("打开会话失败", error);
			if (!isCurrent()) return null;
			pushToast("warning", "toast.sessionOpenFailed", errText(error));
			return null;
		}
		// 数据先落：meta 进 tabs + LRU 打点 —— 这些与「谁抢到焦点」无关（由调用者的 token 决定）。
		// lastUsedAt 必须在数据路径打：用户确实点了这一行，不然 GC 会把它当成「从没用过」。
		if (!isCurrent()) return null;
		ports.landMeta(meta);
		if (!loadBundle) return isCurrent() ? meta : null;
		try {
			// 运行中子会话的事件已按其 sessionId 实时转发；保留已有流式态，
			// 否则会在点击卡片时把 agent_start 建立的进度视图重置为静态历史。
			await loadSessionBundle(meta.sessionId, { skipHistoryIfLive: true });
		} catch (error) {
			// 会话已经打开了（后端在内存里、meta 在 tabs）：数据装载失败只能提示，
			// 不能当成「打开失败」——否则用户点了行却什么都没发生。
			console.error("装载会话数据失败", error);
			if (!isCurrent()) return null;
			pushToast("warning", "toast.sessionOpenFailed", errText(error));
		}
		return isCurrent() ? meta : null;
	}

	function forget(sessionId: string, file?: string): void {
		clearSessionHistory(sessionId);
		if (file) openInFlight.delete(file.trim());
		bundleInFlight.delete(sessionId);
	}
	return { ensureOpenSession, loadSessionBundle, restorePermissionMode, forget };
}
