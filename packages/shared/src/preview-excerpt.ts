/**
 * Minimap 预览用的纯文本摘要：去掉 Markdown 标记（代码围栏、行内代码、标题/列表/引用前缀、强调、链接），
 * 折叠空白，按码点截断。只用于展示一两行预览，不追求完整 Markdown 语义。
 */
export function previewExcerpt(text: string, max = 120): string {
	// 只在前缀不含任何可能参与 Markdown 匹配的字符时提前返回；数字可能是有序列表前缀。
	// 多取一个归一化码点，确保截断位置的空格不会因后文缺失而被 trim 掉。
	if (Number.isFinite(max) && max > 0 && max < 4096) {
		let prefix = text.slice(0, 4096);
		if (prefix.length < text.length && /[\uD800-\uDBFF]$/u.test(prefix)) {
			prefix = prefix.slice(0, -1);
		}
		if (!/[`~!*_[\]#>+\d-]/u.test(prefix)) {
			const chars = Array.from(prefix.replace(/\s+/gu, " ").trim());
			if (chars.length > Math.trunc(max)) return chars.slice(0, max).join("");
		}
	}
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
