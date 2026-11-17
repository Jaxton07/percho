import type { NodeRendererProps } from "markstream-react";

/** Only already-final, unambiguous single paragraphs; keep the library's DOM and typography. */
export function plainParagraphNodes(
	text: string,
	{ streaming = false, smoothStreaming = false }: { streaming?: boolean; smoothStreaming?: boolean } = {},
): NodeRendererProps["nodes"] {
	if (streaming || smoothStreaming || text.length < 64 * 1024) return undefined;
	// No block prefixes, links, escapes, markup or whitespace whose parsing is context-dependent.
	// Unicode prose is supported, but uncertain characters deliberately use the normal parser.
	if (!/^\p{L}/u.test(text) || !/^[\p{L}\p{N} ,.!?，。！？、；：“”‘’（）]+$/u.test(text)) return undefined;
	// markdown-it's linkifier/typographer changes domains, ellipses and repeated punctuation.
	if (/\.(?! |$)|,,|[!?]{2}/u.test(text)) return undefined;
	const content = text.trimEnd();
	const paragraph = {
		type: "paragraph",
		raw: content,
		children: [{ type: "text", content, raw: content, center: false }],
	};
	return [paragraph];
}
