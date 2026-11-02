import { create } from "zustand";

/** chip → 侧栏跳转目标（nonce 保证重复跳同文件也重触发） */
export interface DiffFocus {
	/** 目标来源段，包含同文件的后续段。 */
	sectionKey: string;
	sessionId?: string;
	nonce: number;
}

interface UiStore {
	/** todo 面板展开态（按会话，切换会话互不影响；不含持久化） */
	todoExpanded: Record<string, boolean>;
	toggleTodoExpanded: (sessionId: string) => void;
	/** diff 侧栏开关（内存态，不持久化——重启统一关闭，用户已定） */
	diffSidebarOpen: boolean;
	setDiffSidebarOpen: (open: boolean) => void;
	toggleDiffSidebar: () => void;
	/** chip 跳转侧栏的聚焦目标（侧栏消费后清除） */
	diffFocus: DiffFocus | null;
	setDiffFocus: (sectionKey: string, sessionId?: string) => void;
	clearDiffFocus: () => void;
}

/** 界面态里只放「不跨会话、不落盘」的瞬时开关；持久化偏好一律走 ui-preferences */
export const useUiStore = create<UiStore>((set) => ({
	todoExpanded: {},
	toggleTodoExpanded: (sessionId) =>
		set((state) => ({
			todoExpanded: { ...state.todoExpanded, [sessionId]: !state.todoExpanded[sessionId] },
		})),
	diffSidebarOpen: false,
	setDiffSidebarOpen: (open) => set({ diffSidebarOpen: open }),
	toggleDiffSidebar: () => set((state) => ({ diffSidebarOpen: !state.diffSidebarOpen })),
	diffFocus: null,
	setDiffFocus: (sectionKey, sessionId) =>
		set((state) => ({ diffFocus: { sectionKey, sessionId, nonce: (state.diffFocus?.nonce ?? 0) + 1 } })),
	clearDiffFocus: () => set({ diffFocus: null }),
}));
