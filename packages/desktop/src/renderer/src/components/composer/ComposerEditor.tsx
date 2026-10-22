import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalExtensionEditorComposer } from "@lexical/react/LexicalExtensionEditorComposer";
import type { ComposerDocument, ComposerPart } from "@percho/shared";
import {
	$createTextNode,
	$getRoot,
	$getSelection,
	$insertNodes,
	$isRangeSelection,
	HISTORY_PUSH_TAG,
} from "lexical";
import {
	type ClipboardEvent,
	forwardRef,
	type KeyboardEvent,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";
import { $readComposerSelection, $selectComposerOffset, $selectComposerRange } from "./editor-document";
import { getComposerEditor, syncComposerDocument } from "./editor-host";
import { $createReferenceNode } from "./ReferenceNode";

export interface ComposerEditorHandle {
	focus: (position?: number | "end") => void;
	replaceText: (start: number, end: number, text: string) => void;
	insertReference: (start: number, end: number, reference: Exclude<ComposerPart, { type: "text" }>) => void;
}

interface Props {
	draftKey: string;
	document: ComposerDocument;
	placeholder: string;
	readOnly: boolean;
	className?: string;
	onChange: (document: ComposerDocument, text: string, cursor: number) => void;
	onSelectionChange: (text: string, cursor: number) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor(props, ref) {
	// draftKey 决定内核身份；文档更新只由明确的同步入口处理，不能因此重建编辑器。
	// biome-ignore lint/correctness/useExhaustiveDependencies: document 不是实例身份
	const entry = useMemo(() => getComposerEditor(props.draftKey, props.document), [props.draftKey]);
	const latest = useRef(props);
	latest.current = props;
	useImperativeHandle(
		ref,
		() => ({
			replaceText: (start, end, text) => {
				entry.editor.update(
					() => {
						$selectComposerRange(start, end);
						const selection = $getSelection();
						if ($isRangeSelection(selection)) selection.insertText(text);
					},
					{ tag: HISTORY_PUSH_TAG },
				);
			},
			insertReference: (start, end, reference) => {
				entry.editor.update(
					() => {
						$selectComposerRange(start, end);
						$insertNodes([$createReferenceNode(reference), $createTextNode(" ")]);
					},
					{ tag: HISTORY_PUSH_TAG },
				);
				entry.editor.focus();
			},
			focus: (position) => {
				entry.editor.update(() => {
					if (position === "end") $getRoot().selectEnd();
					else if (typeof position === "number") $selectComposerOffset(position);
				});
				entry.editor.focus();
			},
		}),
		[entry],
	);
	useEffect(() => {
		entry.editor.setEditable(!props.readOnly);
	}, [entry, props.readOnly]);
	useEffect(() => syncComposerDocument(entry, props.document), [entry, props.document]);
	useEffect(
		() =>
			entry.editor.registerUpdateListener(({ editorState }) => {
				editorState.read(() => {
					const state = $readComposerSelection();
					if (JSON.stringify(state.document) !== JSON.stringify(entry.document)) {
						entry.document = state.document;
						latest.current.onChange(state.document, state.completionText, state.cursor);
					}
					if (!entry.editor.isComposing())
						latest.current.onSelectionChange(state.completionText, state.cursor);
				});
			}),
		[entry],
	);
	return (
		<LexicalExtensionEditorComposer initialEditor={entry.editor}>
			<div className={`relative ${props.className ?? ""}`}>
				<ContentEditable
					className="composer-editor w-full min-h-[1.5lh] max-h-[200px] overflow-y-auto bg-transparent text-ui-14 leading-relaxed outline-none select-text thin-scrollbar"
					aria-label={props.placeholder}
					aria-placeholder={props.placeholder}
					placeholder={
						<span className="pointer-events-none absolute top-0 left-0 text-ui-14 leading-relaxed text-ink-faint">
							{props.placeholder}
						</span>
					}
					onKeyDownCapture={(event) => {
						if (event.nativeEvent.isComposing || entry.editor.isComposing()) return;
						props.onKeyDown(event);
						if (event.defaultPrevented) event.stopPropagation();
					}}
					onPasteCapture={(event) => {
						props.onPaste(event);
						if (event.defaultPrevented) event.stopPropagation();
					}}
				/>
			</div>
		</LexicalExtensionEditorComposer>
	);
});
