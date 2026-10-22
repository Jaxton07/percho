import { LexicalBuilder } from "@lexical/extension";
import { HistoryExtension } from "@lexical/history";
import { ReactExtension } from "@lexical/react/ReactExtension";
import { ReactProviderExtension } from "@lexical/react/ReactProviderExtension";
import { RichTextExtension } from "@lexical/rich-text";
import type { ComposerDocument } from "@percho/shared";
import {
	CLEAR_HISTORY_COMMAND,
	configExtension,
	defineExtension,
	HISTORY_PUSH_TAG,
	type LexicalEditorWithDispose,
	TextNode,
} from "lexical";
import { $replaceComposerDocument } from "./editor-document";
import { ReferenceNode } from "./ReferenceNode";

const extension = defineExtension({
	name: "percho/composer",
	namespace: "percho-composer",
	dependencies: [RichTextExtension, HistoryExtension],
	nodes: [ReferenceNode],
});

interface EditorEntry {
	editor: LexicalEditorWithDispose;
	document: ComposerDocument;
}

/** 一个草稿键一个内核，切换只解绑 DOM；会话卸载时释放，业务草稿仍由 draft store 持有。 */
const editors = new Map<string, EditorEntry>();

export function getComposerEditor(key: string, document: ComposerDocument): EditorEntry {
	const existing = editors.get(key);
	if (existing) return existing;
	const editor = LexicalBuilder.fromExtensions([
		ReactProviderExtension,
		configExtension(ReactExtension, { contentEditable: null }),
		extension,
	]).buildEditor();
	// 富文本内核用于结构化剪贴板；产品正文仍然只有文字与引用，不保留外部排版。
	editor.registerNodeTransform(TextNode, (node) => {
		if (node.getFormat() !== 0) node.setFormat(0);
		if (node.getStyle()) node.setStyle("");
	});
	editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
	editor.update(() => $replaceComposerDocument(document), { discrete: true });
	const entry = { editor, document };
	editors.set(key, entry);
	return entry;
}

export function syncComposerDocument(entry: EditorEntry, document: ComposerDocument) {
	if (entry.document === document) return;
	if (JSON.stringify(entry.document) !== JSON.stringify(document)) {
		if (document.parts.length === 0) entry.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
		entry.editor.update(() => $replaceComposerDocument(document), { tag: HISTORY_PUSH_TAG, discrete: true });
	}
	entry.document = document;
}

export function releaseComposerEditor(key: string) {
	const entry = editors.get(key);
	if (!entry) return;
	entry.editor.dispose();
	editors.delete(key);
}
