/** 编辑器无关的输入内容；资源身份由 backend 分配，正文不携带 skill 全文。 */
export type ComposerPart =
	| { type: "text"; text: string }
	| { type: "skill"; id: string; label: string }
	| { type: "file"; path: string; label?: string; kind?: "file" | "directory" };

export interface ComposerDocument {
	version: 1;
	parts: ComposerPart[];
}

export const EMPTY_COMPOSER_DOCUMENT: ComposerDocument = { version: 1, parts: [] };

export function composerDocumentFromText(text: string): ComposerDocument {
	return text ? { version: 1, parts: [{ type: "text", text }] } : EMPTY_COMPOSER_DOCUMENT;
}

export function composerPartText(part: ComposerPart): string {
	return part.type === "text"
		? part.text
		: part.type === "skill"
			? part.label
			: `@${part.label ?? part.path}`;
}

/** 文件的展示名可以是相对路径；模型始终收到插入时绑定的绝对路径。 */
export function composerDocumentModelText(document: ComposerDocument): string {
	return document.parts
		.map((part) => (part.type === "file" ? `@${part.path}` : composerPartText(part)))
		.join("");
}

export function composerDocumentText(document: ComposerDocument): string {
	return document.parts.map(composerPartText).join("");
}

export function appendComposerDocument(current: ComposerDocument, next: ComposerDocument): ComposerDocument {
	return normalizeComposerDocument({
		version: 1,
		parts: [
			...current.parts,
			...(current.parts.length && next.parts.length ? [{ type: "text" as const, text: "\n" }] : []),
			...next.parts,
		],
	});
}

export function readComposerDocument(message: unknown): ComposerDocument | undefined {
	const value = (message as { perchoInput?: unknown } | null)?.perchoInput;
	if (value === undefined) return undefined;
	try {
		return parseComposerDocument(value);
	} catch {
		// An unknown history version must not reveal the expanded skill definitions as ordinary body.
		return composerDocumentFromText("[Unsupported composer input]");
	}
}

export function normalizeComposerDocument(document: ComposerDocument): ComposerDocument {
	const parts: ComposerPart[] = [];
	for (const part of document.parts) {
		if (part.type === "text") {
			if (!part.text) continue;
			const previous = parts.at(-1);
			if (previous?.type === "text") previous.text += part.text;
			else parts.push({ ...part });
		} else parts.push({ ...part });
	}
	return parts.length ? { version: 1, parts } : EMPTY_COMPOSER_DOCUMENT;
}

export function parseComposerDocument(value: unknown): ComposerDocument {
	if (!value || typeof value !== "object") throw new Error("Invalid composer document");
	const doc = value as Record<string, unknown>;
	if (doc.version !== 1 || !Array.isArray(doc.parts)) throw new Error("Invalid composer document");
	const parts = doc.parts.map((item: unknown): ComposerPart => {
		if (!item || typeof item !== "object") throw new Error("Invalid composer part");
		const part = item as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
		if (part.type === "skill" && typeof part.id === "string" && part.id && typeof part.label === "string") {
			return { type: "skill", id: part.id, label: part.label };
		}
		if (part.type === "file" && typeof part.path === "string" && part.path) {
			if (part.label !== undefined && typeof part.label !== "string") throw new Error("Invalid file label");
			// kind 只决定图标，认不出的值当作没有：不能让一个展示字段把整条消息变成占位符。
			return {
				type: "file",
				path: part.path,
				...(part.label === undefined ? {} : { label: part.label as string }),
				...(part.kind === "directory" ? { kind: "directory" as const } : {}),
			};
		}
		throw new Error("Invalid composer part");
	});
	return normalizeComposerDocument({ version: 1, parts });
}
