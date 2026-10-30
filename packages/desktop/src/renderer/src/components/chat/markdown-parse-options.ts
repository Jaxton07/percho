import type { NodeRendererProps } from "markstream-react";

export const markdownParseOptions: NonNullable<NodeRendererProps["parseOptions"]> = {
	postTransformTokens: (tokens) =>
		tokens.map((token) => {
			// 围栏代码的行结束符会被 Monaco 算成额外一行；只去掉一次，保留主动留的空行。
			// 流式尚未闭合时保留换行，下一段内容可能继续写入该行。
			if (token.type !== "fence" || token.meta?.closed !== true || !token.content) return token;
			return { ...token, content: token.content.replace(/\r?\n$/, "") };
		}),
};
