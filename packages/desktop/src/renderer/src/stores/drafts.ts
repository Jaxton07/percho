import type { ImageInput } from "@percho/shared";
import { create } from "zustand";

/** 无活跃会话（未创建的新会话）时的草稿 key */
export const NEW_SESSION_DRAFT_KEY = "__new__";

/** 请求聚焦输入框的窗口事件名（撤回回填草稿后由 store 派发，Composer 监听聚焦 textarea） */
export const COMPOSER_FOCUS_EVENT = "pi:composer-focus";

/** 一份会话草稿：文本 + 图片附件 + slash 命令胶囊 + @ 文件引用胶囊 */
export interface DraftEntry {
	text: string;
	images: ImageInput[];
	slashCommand: string | null;
	/** @ 文件引用（项目相对路径）；发送时拼回 @path 列表置于正文前 */
	attachments: string[];
}

/** 模块级共享空态（selector 缺省返回，引用稳定防重渲染循环） */
export const EMPTY_DRAFT: DraftEntry = { text: "", images: [], slashCommand: null, attachments: [] };

/**
 * 输入框草稿按会话保存。Composer 会在空态（EmptyState 内）与列表态（底部）之间切换实例，
 * 本地 useState 会丢草稿；且不同会话的草稿应各自独立（A 的不串到 B）。全空条目不入表。
 */
interface DraftStore {
	bySession: Record<string, DraftEntry>;
	/** 更新某会话草稿（传整个条目的变换函数）；结果全空时删除条目 */
	updateDraft: (key: string, updater: (entry: DraftEntry) => DraftEntry) => void;
}

function isEmpty(entry: DraftEntry): boolean {
	return !entry.text && entry.images.length === 0 && !entry.slashCommand && entry.attachments.length === 0;
}

export const useDraftStore = create<DraftStore>((set) => ({
	bySession: {},
	updateDraft: (key, updater) =>
		set((state) => {
			const next = updater(state.bySession[key] ?? EMPTY_DRAFT);
			if (isEmpty(next)) {
				if (!(key in state.bySession)) return state;
				const rest = { ...state.bySession };
				delete rest[key];
				return { bySession: rest };
			}
			return { bySession: { ...state.bySession, [key]: next } };
		}),
}));
