/**
 * 频道订阅胶囊的**显示状态机**（pure，spec D2）。
 *
 * 为什么要独立成纯函数：胶囊有一堆容易出错的时序要求，而它们都不该藏在 effect 里：
 * - 退订最后一个频道要**保留退场文本**直到收起完成（DOM 不能立刻消失）；
 * - 快速订阅/退订来回切要从当前状态接续，**旧 timer 不能删掉新胶囊**（令牌守卫）；
 * - 切会话**不许播放旧会话内容**（硬重置，不走过场动画，旧名字绝不串到新会话）。
 *
 * 状态：`display` = 当前展示的 topic（离场期间保留旧值）；`opened` = 目标展开态；
 * `mounted` = DOM 是否挂在树族上（离场中仍 true）；`token` = 每次跃迁 +1 的令牌；
 * `sessionId` = 这份展示属于哪个会话（**渲染层据此立刻隐藏**，不必等 effect 重置 —— 否则会有 1~2 帧
 * 把旧会话的名字画在新会话上，阶段 4 真机测到过）。
 */
export interface ChannelPillPresence {
	sessionId: string | null;
	display: readonly string[];
	opened: boolean;
	mounted: boolean;
	token: number;
}

export type ChannelPillEvent =
	/** 订阅集合变化（当前会话的 topics） */
	| { type: "sync"; sessionId: string | null; topics: readonly string[] }
	/** 收起动画结束（带令牌；过期事件一律忽略） */
	| { type: "exitFinished"; token: number }
	/** 切会话：硬重置（不播旧内容、不走过场） */
	| { type: "reset"; sessionId: string | null };

export const HIDDEN_PRESENCE: ChannelPillPresence = {
	sessionId: null,
	display: [],
	opened: false,
	mounted: false,
	token: 0,
};

/** 渲染用：这份展示只属于 `sessionId` 时才可见（切会话那一帧立刻隐藏旧内容） */
export function presenceForSession(
	state: ChannelPillPresence,
	sessionId: string | null,
): ChannelPillPresence {
	return state.sessionId === sessionId ? state : HIDDEN_PRESENCE;
}

export function reduceChannelPill(state: ChannelPillPresence, event: ChannelPillEvent): ChannelPillPresence {
	switch (event.type) {
		case "sync": {
			if (event.topics.length > 0) {
				// 展开（含「离场中被重新订阅」：令牌 +1 让还在跑的收起定时器作废，从当前宽度接续展开）
				return {
					sessionId: event.sessionId,
					display: event.topics,
					opened: true,
					mounted: true,
					token: state.token + 1,
				};
			}
			if (!state.mounted) return state; // 本来就是空的：不动（也避免无谓的令牌推进）
			if (!state.opened) return state; // 已在离场中：保持原令牌，别把正在跑的收起定时器废掉
			// 退订到空：保留 display（退场文本），开始收起
			return { ...state, opened: false, token: state.token + 1 };
		}
		case "exitFinished": {
			if (event.token !== state.token) return state; // 旧 timer / 旧 transitionend
			if (!state.opened && !state.mounted) return state;
			return { ...state, display: [], opened: false, mounted: false };
		}
		case "reset":
			return { ...HIDDEN_PRESENCE, sessionId: event.sessionId, token: state.token + 1 };
	}
}
