import { type ComposerDocument, type ComposerPart, normalizeComposerDocument } from "@percho/shared";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	type LexicalNode,
} from "lexical";
import { $createReferenceNode, ReferenceNode } from "./ReferenceNode";

/** 只在编辑器事务中调用；业务的换行是一处换行，不采用编辑器的段落分隔字符串。 */
function $readComposerContent() {
	let text = "";
	const parts: ComposerPart[] = [];
	const positions = new Map<string, { start: number; end: number; children?: number[] }>();
	const visit = (node: LexicalNode) => {
		const start = text.length;
		if ($isElementNode(node)) {
			const children = [start];
			for (const child of node.getChildren()) {
				visit(child);
				children.push(text.length);
			}
			positions.set(node.getKey(), { start, end: text.length, children });
		} else {
			text += node.getTextContent();
			parts.push(
				node instanceof ReferenceNode ? node.getReference() : { type: "text", text: node.getTextContent() },
			);
			positions.set(node.getKey(), { start, end: text.length });
		}
	};
	const boundaries = [0];
	for (const [index, node] of $getRoot().getChildren().entries()) {
		if (index > 0) {
			text += "\n";
			parts.push({ type: "text", text: "\n" });
		}
		visit(node);
		boundaries.push(text.length);
	}
	positions.set($getRoot().getKey(), { start: 0, end: text.length, children: boundaries });
	// 补全只识别可编辑文字，已有胶囊用等长空白遮蔽，仍使用同一 UTF-16 选区坐标。
	const completionText = parts
		.map((part) =>
			part.type === "text"
				? part.text
				: " ".repeat(part.type === "skill" ? part.label.length : `@${part.label ?? part.path}`.length),
		)
		.join("");
	return { document: normalizeComposerDocument({ version: 1, parts }), text, positions, completionText };
}

export function $readComposerSelection() {
	const { document, text, positions, completionText } = $readComposerContent();
	const selection = $getSelection();
	const point = $isRangeSelection(selection) ? selection.anchor : null;
	const position = point ? positions.get(point.key) : undefined;
	const cursor =
		point && position
			? point.type === "text"
				? position.start + point.offset
				: (position.children?.[point.offset] ?? position.end)
			: text.length;
	return { document, text, completionText, cursor };
}

/** 当前选区（UTF-16 偏移，已排序）；没有选区时返回文末，便于在固定位置插入 */
export function $readComposerRange() {
	const { text, positions } = $readComposerContent();
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return { start: text.length, end: text.length };
	const offsetOf = (point: typeof selection.anchor) => {
		const position = positions.get(point.key);
		if (!position) return text.length;
		return point.type === "text"
			? position.start + point.offset
			: (position.children?.[point.offset] ?? position.end);
	};
	const anchor = offsetOf(selection.anchor);
	const focus = offsetOf(selection.focus);
	return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

export function $replaceComposerDocument(document: ComposerDocument) {
	const root = $getRoot();
	root.clear();
	let paragraph = $createParagraphNode();
	root.append(paragraph);
	for (const part of document.parts) {
		if (part.type !== "text") {
			paragraph.append($createReferenceNode(part));
			continue;
		}
		for (const [index, line] of part.text.split("\n").entries()) {
			if (index > 0) {
				paragraph = $createParagraphNode();
				root.append(paragraph);
			}
			if (line) paragraph.append($createTextNode(line));
		}
	}
}

export function $selectComposerOffset(offset: number) {
	let remaining = offset;
	for (const [index, paragraph] of $getRoot().getChildren().entries()) {
		if (index > 0) remaining--;
		if (!$isElementNode(paragraph)) continue;
		if (remaining <= 0) {
			paragraph.selectStart();
			return;
		}
		for (const node of paragraph.getChildren()) {
			if (remaining <= node.getTextContentSize()) {
				if ($isTextNode(node)) node.select(remaining, remaining);
				else {
					const boundary = node.getIndexWithinParent() + (remaining > 0 ? 1 : 0);
					paragraph.select(boundary, boundary);
				}
				return;
			}
			remaining -= node.getTextContentSize();
		}
	}
	$getRoot().selectEnd();
}

export function $selectComposerRange(start: number, end: number) {
	$selectComposerOffset(end);
	const last = $getSelection();
	if (!$isRangeSelection(last)) return;
	const point = { key: last.anchor.key, offset: last.anchor.offset, type: last.anchor.type };
	$selectComposerOffset(start);
	const selection = $getSelection();
	if ($isRangeSelection(selection)) selection.focus.set(point.key, point.offset, point.type);
}
