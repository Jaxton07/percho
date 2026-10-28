import {
	appendComposerDocument,
	type ComposerDocument,
	composerDocumentFromText,
	composerDocumentText,
	EMPTY_COMPOSER_DOCUMENT,
	type EnvironmentRef,
	environmentEntityKey,
	type ImageInput,
	LOCAL_ENVIRONMENT,
	type QueuedInput,
	type UiError,
} from "@percho/shared";
import { create } from "zustand";

/**
 * 新会话页（`activeSessionId === null`）的草稿 key。
 * 单例 draft：全局只有这一份新会话内容，新建/再点「＋」/promotion 前后都不换 key。
 */
export const NEW_SESSION_DRAFT_KEY = "__new__";

/** Remote new-session inputs belong to their environment/project, never the local compatibility key. */
export function newSessionDraftKey(
	environment: EnvironmentRef = LOCAL_ENVIRONMENT,
	cwd?: string | null,
): string {
	return environment.kind === "local"
		? NEW_SESSION_DRAFT_KEY
		: environmentEntityKey(environment, `draft:${cwd ?? ""}`);
}

/** 请求聚焦输入框的窗口事件名（撤回回填草稿后由 store 派发，Composer 监听聚焦编辑器） */
export const COMPOSER_FOCUS_EVENT = "pi:composer-focus";

/** 一份会话草稿：文本 + 图片附件 + slash 命令胶囊 + @ 文件引用胶囊 + 选中引用胶囊 */
export interface DraftEntry {
	document: ComposerDocument;
	images: ImageInput[];
	slashCommand: string | null;
	/** 选中引用（对话区选中内容弹菜单添加）；发送时逐条转 blockquote 段落置于最前 */
	quotes: string[];
}

/** 模块级共享空态（selector 缺省返回，引用稳定防重渲染循环） */
export const EMPTY_DRAFT: DraftEntry = {
	document: EMPTY_COMPOSER_DOCUMENT,
	images: [],
	slashCommand: null,
	quotes: [],
};

/**
 * 输入框草稿按会话保存。Composer 会在空态（EmptyState 内）与列表态（底部）之间切换实例，
 * 本地 useState 会丢草稿；且不同会话的草稿应各自独立（A 的不串到 B）。全空条目不入表。
 */
interface DraftStore {
	bySession: Record<string, DraftEntry>;
	failedBySession: Record<string, DraftEntry>;
	pendingBySession: Record<string, boolean>;
	errorsBySession: Record<string, UiError | undefined>;
	/** 更新某会话草稿（传整个条目的变换函数）；结果全空时删除条目 */
	updateDraft: (key: string, updater: (entry: DraftEntry) => DraftEntry) => void;
}

function isEmpty(entry: DraftEntry): boolean {
	return (
		entry.document.parts.length === 0 &&
		entry.images.length === 0 &&
		!entry.slashCommand &&
		entry.quotes.length === 0
	);
}

export const useDraftStore = create<DraftStore>((set) => ({
	bySession: {},
	failedBySession: {},
	pendingBySession: {},
	errorsBySession: {},
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

export function draftText(entry: DraftEntry): string {
	return composerDocumentText(entry.document);
}

export function withDraftText(entry: DraftEntry, text: string): DraftEntry {
	return { ...entry, document: composerDocumentFromText(text) };
}

export function appendDraftInput(entry: DraftEntry, input: QueuedInput): DraftEntry {
	return {
		...entry,
		document: appendComposerDocument(entry.document, input.document),
		images: [...entry.images, ...input.images],
	};
}

/** 同步消费当前快照，先清空再 await；之后的新输入不会被旧发送清掉。 */
export function takeDraft(key: string): DraftEntry {
	const entry = useDraftStore.getState().bySession[key] ?? EMPTY_DRAFT;
	useDraftStore.getState().updateDraft(key, () => EMPTY_DRAFT);
	return entry;
}

export function restoreRejectedDraft(key: string, entry: DraftEntry, conflict = false) {
	useDraftStore.setState((state) => {
		if (!conflict && !state.bySession[key]) return { bySession: { ...state.bySession, [key]: entry } };
		return { failedBySession: { ...state.failedBySession, [key]: entry } };
	});
}

/** 显式恢复时交换两份草稿，用户刚写的内容仍可找回，不猜测如何拼接。 */
export function restoreFailedDraft(key: string) {
	useDraftStore.setState((state) => {
		const failed = state.failedBySession[key];
		if (!failed) return state;
		const pending = { ...state.failedBySession };
		const current = state.bySession[key];
		if (current) pending[key] = current;
		else delete pending[key];
		return { bySession: { ...state.bySession, [key]: failed }, failedBySession: pending };
	});
}
