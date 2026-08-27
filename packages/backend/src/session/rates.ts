/**
 * 每会话事件速率统计（临终快照与心跳的数据源，spec log-trace-hardening 决策 3）。
 *
 * emitEvent 单点 tick：{秒起点, 每秒计数[]}，跨秒补零、窗口 60 秒。纯内存零磁盘，
 * 只记数字（每秒事件数 / 最近事件时刻）——绝不记消息正文，隐私与体积双保险。
 * 供「renderer 死前多忙 / 正在流式中死亡还是空闲死亡」的事故归因。
 */

/** 速率窗口（秒）。60s 粒度足够（事故形态是小时级爬坡，不是秒级尖峰） */
const WINDOW_SECONDS = 60;
/** prune 判定的闲置时长：不在 keep 集内且超过该时长无事件的条目可清理 */
const STALE_MS = 60_000;

export interface SessionRateSnapshot {
	/** 最近 60s 每秒事件数（旧→新；活跃秒不足 60 个时短于 60） */
	window60s: number[];
	/** 最近一次事件时刻（epoch ms；快照方算 lastEventAgeMs） */
	lastEventAt: number;
}

interface RateState {
	counts: number[];
	secStart: number;
	lastEventAt: number;
}

export class EventRateTracker {
	private readonly states = new Map<string, RateState>();

	/** 记一次事件（now 可注入，测试用） */
	tick(sessionId: string, now: number = Date.now()): void {
		const sec = Math.floor(now / 1000) * 1000;
		let st = this.states.get(sessionId);
		if (!st) {
			st = { counts: [], secStart: sec, lastEventAt: now };
			this.states.set(sessionId, st);
		} else if (sec > st.secStart) {
			// 跨秒：中间每秒补零；闲置超过整个窗口则旧计数整段作废（不灌 60 个零）
			const gapSec = (sec - st.secStart) / 1000;
			if (gapSec >= WINDOW_SECONDS) st.counts.length = 0;
			else for (let i = 0; i < gapSec; i++) st.counts.push(0);
			while (st.counts.length > WINDOW_SECONDS) st.counts.shift();
			st.secStart = sec;
		}
		st.lastEventAt = now;
		const last = st.counts.length - 1;
		if (last >= 0) st.counts[last] = (st.counts[last] ?? 0) + 1;
		else st.counts.push(1);
	}

	/** 全量快照（数组拷贝，防外改内部状态） */
	snapshot(): Map<string, SessionRateSnapshot> {
		const out = new Map<string, SessionRateSnapshot>();
		for (const [id, st] of this.states) {
			out.set(id, { window60s: [...st.counts], lastEventAt: st.lastEventAt });
		}
		return out;
	}

	/** 会话关闭时清理（closeSession/dispose 显式路径） */
	delete(sessionId: string): void {
		this.states.delete(sessionId);
	}

	/**
	 * 清理已结束会话的残留条目：subagent 子会话不走 closeSession（事件按子 sessionId
	 * 进来但从不进 registry），靠「不在 keep 集内且 60s 无事件」判定回收，防 Map 泄漏。
	 */
	prune(keep: (sessionId: string) => boolean, now: number = Date.now()): void {
		for (const [id, st] of this.states) {
			if (!keep(id) && now - st.lastEventAt > STALE_MS) this.states.delete(id);
		}
	}
}
