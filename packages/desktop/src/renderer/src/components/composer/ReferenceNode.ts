import { type ComposerPart, composerPartText, parseComposerDocument } from "@percho/shared";
import {
	$applyNodeReplacement,
	type DOMConversionMap,
	type EditorConfig,
	type NodeKey,
	type SerializedTextNode,
	TextNode,
} from "lexical";

type Reference = Exclude<ComposerPart, { type: "text" }>;
type SerializedReference = SerializedTextNode & { reference: Reference };

export class ReferenceNode extends TextNode {
	__reference: Reference;
	static getType() {
		return "percho-reference";
	}
	static clone(node: ReferenceNode) {
		return new ReferenceNode(node.__reference, node.__key);
	}
	constructor(reference: Reference = { type: "skill", id: "", label: "" }, key?: NodeKey) {
		super(composerPartText(reference), key);
		this.__reference = reference;
	}
	getReference(): Reference {
		return { ...this.getLatest().__reference };
	}
	static importJSON(value: SerializedReference) {
		return $createReferenceNode(value.reference);
	}
	exportJSON(): SerializedReference {
		return {
			...super.exportJSON(),
			reference: this.getReference(),
			type: ReferenceNode.getType(),
			version: 1,
		};
	}
	createDOM(config: EditorConfig) {
		const element = super.createDOM(config);
		element.classList.add("composer-reference", `composer-reference-${this.__reference.type}`);
		if (this.__reference.type === "file" && this.__reference.kind === "directory")
			element.classList.add("composer-reference-directory");
		element.spellcheck = false;
		return element;
	}
	exportDOM() {
		const element = document.createElement("span");
		element.dataset.perchoReference = JSON.stringify(this.getReference());
		element.textContent = this.getTextContent();
		return { element };
	}
	static importDOM(): DOMConversionMap {
		return {
			span: (element) => {
				if (!element.dataset.perchoReference) return null;
				try {
					const part = parseComposerDocument({
						version: 1,
						parts: [JSON.parse(element.dataset.perchoReference)],
					}).parts[0];
					return part && part.type !== "text"
						? { conversion: () => ({ node: $createReferenceNode(part) }), priority: 2 }
						: null;
				} catch {
					return null;
				}
			},
		};
	}
	canInsertTextBefore() {
		return false;
	}
	canInsertTextAfter() {
		return false;
	}
	isTextEntity(): true {
		return true;
	}
}

export function $createReferenceNode(reference: Reference) {
	const part = parseComposerDocument({ version: 1, parts: [reference] }).parts[0];
	if (!part || part.type === "text") throw new Error("Invalid reference");
	return $applyNodeReplacement(new ReferenceNode(part).setMode("token"));
}
