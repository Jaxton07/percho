/**
 * Minimap 预览用的纯文本摘要：去掉 Markdown 标记（代码围栏、行内代码、标题/列表/引用前缀、强调、链接），
 * 折叠空白，按码点截断。只用于展示一两行预览，不追求完整 Markdown 语义。
 */
export function previewExcerpt(text: string, max = 120): string {
	const plain = text
		.replace(/^\s*(```|~~~)[^\n]*$/gmu, " ")
		.replace(/`([^`]*)`/gu, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, "")
		// 星号/波浪线强调直接去标记；下划线强调要求两侧不是字母数字，避免吃掉 snake_case 标识符
		.replace(/(\*\*|\*|~~)(\S(?:.*?\S)?)\1/gu, "$2")
		.replace(/(?<![\p{L}\p{N}])(__|_)(\S(?:.*?\S)?)\1(?![\p{L}\p{N}])/gu, "$2");
	return Array.from(plain.replace(/\s+/gu, " ").trim()).slice(0, max).join("");
}
