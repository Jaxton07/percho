import { stores } from "@percho/plugin-api";
import approvalUrl from "./assets/approval.mp3";
import doneUrl from "./assets/done.mp3";

/**
 * 语音提醒（无头插件）：人不在电脑旁时的召回提示音。
 *
 * 两个提醒场景（都带安静窗口防抖，见 QUIET_MS）：
 * 1. 任务完成 —— 全部打开的会话连续数秒无产出活动后播 done 音；
 * 2. 权限审批 —— 出现待审批请求且持续数秒未被处理时播 approval 音（优先于完成音）。
 *
 * 为什么是「全局安静」而不是单会话结束即提醒：两个会话开频道互相沟通时，
 * A 刚结束就被 B 的消息唤醒继续干活——单会话维度每次循环都会误响；
 * 只有全局（所有打开的会话）安静下来，才是真正需要人回来的时刻。
 *
 * 开关即插件启用开关（UI 插件面板）：禁用 = 卸载副作用（解订阅/清计时），无需额外配置。
 */

/** 宿主 store 的最小命令式形状（无头插件不用 hook，走 getState + subscribe） */
interface StoreApi<T> {
	getState: () => T;
	subscribe: (listener: () => void) => () => void;
}

interface SessionEntryLike {
	agentActive?: boolean;
	compacting?: boolean;
	pendingPermissions?: unknown[];
}

const { useTranscriptStore, useSessionsStore } = stores as {
	useTranscriptStore: StoreApi<{ bySession: Record<string, SessionEntryLike> }>;
	useSessionsStore: StoreApi<{ sessions: { sessionId: string }[] }>;
};

/** 安静窗口：全局转闲后再等这么久才算真安静（窗口内又开工则作废重来） */
const QUIET_MS = 5000;
/** 提示音量 */
const VOLUME = 0.9;

export function activate(): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** 自上次提醒以来发生过「忙→闲」完成事件（播放 done 音后清零；期间再次开工不清零——最终安静一并提醒） */
	let completionArmed = false;
	/** 已提醒过的待审批数（只有出现更多新请求才再次提醒，人不在时升级召回） */
	let notifiedPending = 0;
	let prevWorking = false;
	let prevPending = 0;

	const clearTimer = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const play = (url: string) => {
		const audio = new Audio(url);
		audio.volume = VOLUME;
		audio.play().catch((err) => console.error("[voice-alerts] 播放失败", err));
	};

	/** 派生全局状态（只看打开的会话）：
	 *  working = 有会话在产出（agent 运行中 / 压缩中）；等审批不算产出——agent 停着等人，正是要提醒的时刻
	 *  pending = 待审批请求总数 */
	const derive = (): { working: boolean; pending: number } => {
		const open = new Set(useSessionsStore.getState().sessions.map((s) => s.sessionId));
		let working = false;
		let pending = 0;
		for (const [id, entry] of Object.entries(useTranscriptStore.getState().bySession)) {
			if (!open.has(id)) continue;
			const p = entry.pendingPermissions?.length ?? 0;
			if (p > 0) pending += p;
			else if (entry.agentActive || entry.compacting) working = true;
		}
		return { working, pending };
	};

	/** 安静窗口到期裁决：审批优先于完成（人不在时审批是更强的召回信号） */
	const settle = () => {
		timer = null;
		const { working, pending } = derive();
		if (working) return; // 窗口内又开工了：等下一次转闲重新起算
		if (pending > 0) {
			if (pending > notifiedPending) {
				play(approvalUrl);
				notifiedPending = pending;
				// 审批召回已达成目的：清掉待发的完成提醒，避免紧接着再补一声 done（人可能已回来）
				completionArmed = false;
			}
			return;
		}
		if (completionArmed) {
			play(doneUrl);
			completionArmed = false;
		}
	};

	const onStoreChange = () => {
		const { working, pending } = derive();
		// 完成记账：全局「忙→闲」边沿（含因审批暂停的回合；真结束时自然触发）
		if (prevWorking && !working) completionArmed = true;
		// 审批被批掉一些：提醒水位同步下调
		if (pending < prevPending) notifiedPending = Math.min(notifiedPending, pending);
		prevWorking = working;
		prevPending = pending;
		if (working) {
			clearTimer(); // 还在产出：安静窗口无意义
			return;
		}
		// 全局空闲：启动（或重置）安静窗口——完成转闲 / 审批出现都从这里起算
		clearTimer();
		timer = setTimeout(settle, QUIET_MS);
	};

	// 激活基线：不把激活前就存在的状态当边沿
	const base = derive();
	prevWorking = base.working;
	prevPending = base.pending;
	notifiedPending = base.pending;

	const unsubs = [useTranscriptStore.subscribe(onStoreChange), useSessionsStore.subscribe(onStoreChange)];

	return () => {
		clearTimer();
		for (const unsub of unsubs) unsub();
	};
}
