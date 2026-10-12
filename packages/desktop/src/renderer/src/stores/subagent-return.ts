import { create } from "zustand";

/**
 * 子代理检视页的「返回父会话」关系（spec D4）。
 *
 * 为什么是独立叶子 store（而不是 sessions store 里的一张 Map）：
 * - 关系是在 `openFromHistory` **之后**才写入的（那时 activeSessionId 已经写好、组件已经渲染过一轮），
 *   普通 Map 不触发 re-render ⇒ 箭头会晚一拍甚至不出现；zustand store 天然响应式。
 * - 依赖方向：本模块**只** import zustand（不 import 任何 store）⇒ 作为叶子被 sessions/projects
 *   与组件同时 import 也不会造成 renderer 模块环（自查脚本 `.local/agent-work/probe/check-module-cycles.mjs`）。
 *
 * 生命周期（spec D4）：
 * - 写入：只有「这次点击真的打开了子会话、且它仍是最新导航意图」才写（见 `openSubagentSession`）；
 * - 保留：父会话被 GC 卸载**不清**（正是要靠 `parentFile` 重开）；
 * - 清理：会话被**删除**（用户/外部）时清 —— 作为父（`forgetChildrenOf`）与作为子（`forgetChild`）都清。
 */
export interface SubagentReturnTarget {
	parentSessionId: string;
	/** 父会话文件：父会话已被 GC 卸载时靠它重开（`SessionMeta.sessionFile`） */
	parentFile?: string;
}

interface SubagentReturnState {
	/** childSessionId → 父目标（内存态，不落盘） */
	relations: Record<string, SubagentReturnTarget>;
	remember: (childSessionId: string, target: SubagentReturnTarget) => void;
	forgetChild: (childSessionId: string) => void;
	forgetChildrenOf: (parentSessionId: string) => void;
}

export const useSubagentReturnStore = create<SubagentReturnState>((set) => ({
	relations: {},

	/** 同一子会话被不同父会话先后打开时由**最新入口**覆盖（spec D4） */
	remember: (childSessionId, target) =>
		set((state) => ({ relations: { ...state.relations, [childSessionId]: target } })),

	forgetChild: (childSessionId) =>
		set((state) => {
			if (!state.relations[childSessionId]) return state;
			const relations = { ...state.relations };
			delete relations[childSessionId];
			return { relations };
		}),

	forgetChildrenOf: (parentSessionId) =>
		set((state) => {
			const entries = Object.entries(state.relations).filter(
				([, target]) => target.parentSessionId === parentSessionId,
			);
			if (entries.length === 0) return state;
			const relations = { ...state.relations };
			for (const [childSessionId] of entries) delete relations[childSessionId];
			return { relations };
		}),
}));
