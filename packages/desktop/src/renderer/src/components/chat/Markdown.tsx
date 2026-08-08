import MarkdownRender from "markstream-react";
import "markstream-react/index.css";
import { useThemeStore } from "../../stores/theme";

/**
 * Markdown 渲染：markstream-react（增量解析，为流式 token 设计，避免 react-markdown 每帧全量 re-parse）。
 * final=false 时未闭合的构造（代码块/表格/链接）按 pending 渲染；提交后必须 true。
 * 样式：组件自带 CSS（:where() 零优先级），视觉覆写集中在 globals.css 的 .markdown-body 下。
 * isDark 驱动代码块 shiki 主题（vitesse-light/dark）与容器深浅。
 */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	const isDark = useThemeStore((s) => s.resolved === "dark");
	return (
		<div className="markdown-body text-[14px] leading-relaxed text-ink select-text">
			<MarkdownRender content={text} final={!streaming} fade={false} isDark={isDark} />
		</div>
	);
}
