import MarkdownRender from "markstream-react";
import "markstream-react/index.css";
import { useRef } from "react";

/** 平滑输出参数（与桌面端 Markdown.tsx 同款：min 80cps，其余默认；final 后追平不跳变） */
const SMOOTH_OPTIONS = { minCharsPerSecond: 80 } as const;

const REDUCED_MOTION =
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Markdown 渲染（markstream-react，增量解析）。lan-web 版：isDark 由调用方 prop 传入
 * （桌面版从 theme store 读）。流式平滑只在挂载时 streaming=true 的消息启用（useRef 锁初值，
 * 历史消息不整篇重播）。deferNodesUntilVisible=false：0.0.55 延迟节点 bug（占位条不刷新）。
 */
export function Markdown({
	text,
	streaming,
	isDark,
}: {
	text: string;
	streaming?: boolean;
	isDark: boolean;
}) {
	const smoothableRef = useRef<boolean>(Boolean(streaming) && !REDUCED_MOTION);
	return (
		<div className="markdown-body">
			<MarkdownRender
				content={text}
				final={!streaming}
				fade={!REDUCED_MOTION}
				smoothStreaming={smoothableRef.current}
				smoothStreamingOptions={SMOOTH_OPTIONS}
				isDark={isDark}
				deferNodesUntilVisible={false}
			/>
		</div>
	);
}
