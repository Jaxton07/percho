import MarkdownRender, { type SmoothMarkdownStreamOptions } from "markstream-react";
import "markstream-react/index.css";
import { useRef } from "react";
import { useThemeStore } from "../../stores/theme";

/**
 * 平滑输出速率参数（markstream 内置 smooth streaming controller，grapheme 级 pacing）：
 * - min 80 cps：小 delta 时的基速（利落的打字机感，不拖沓）
 * - 自适应：backlog <600 字在 900ms 内追平；超过则切换到 350ms 快进（≤1000 cps、
 *   每次 commit ≤80 字、30fps）——大 trunk 变成连续滑出而非整块蹦现，且不会越积越多
 * - flushOnFinish 保持 false：final（turn_end 固化）后不跳变，继续平滑追完剩余 backlog
 */
const SMOOTH_OPTIONS: SmoothMarkdownStreamOptions = {
	minCharsPerSecond: 80,
	// 其余（targetLatencyMs 900 / catchUpLatencyMs 350 / catchUpThreshold 600 / max 1000cps）用默认
};

const CODE_BLOCK_PROPS = {
	// 标题栏在视觉上被 CSS 悬浮化（见 globals.css），这里只裁掉多余按钮：字号三键/全屏/预览，
	// 保留折叠 + 复制。不能用 showHeader:false——它会连按钮一起去掉，且折叠是组件内部 state，外部无法控制。
	showFontSizeButtons: false,
	showExpandButton: false,
	showPreviewButton: false,
} as const;

/** 减速动效偏好：直接关闭 pacing（直出）；库 CSS 自带 animation:none 处理淡入 */
const REDUCED_MOTION =
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Markdown 渲染：markstream-react（增量解析，为流式 token 设计，避免 react-markdown 每帧全量 re-parse）。
 * final=false 时未闭合的构造（代码块/表格/链接）按 pending 渲染；提交后必须 true。
 *
 * 流式丝滑性（两层）：
 * 1. smoothStreaming：内容经自适应速率控制器逐字放出（大 trunk 平滑滑出）。只对「挂载时就在流式」
 *    的消息启用——历史/固化后打开的消息直出（mount 初值锁定，否则整篇会重播一遍）。
 *    流式 → turn_end 固化依赖 MessageList 的 key 稳定（StreamingState.id）保持组件不 remount，
 *    controller 才能存活并平滑追平。
 * 2. fade：新块节点 enter 淡入（.28s）+ 文本节点新增内容交替淡入（text-node-stream-delta a/b）。
 * 样式：组件自带 CSS（:where() 零优先级），视觉覆写集中在 globals.css 的 .markdown-body 下。
 * isDark 驱动代码块 shiki 主题（vitesse-light/dark）与容器深浅。注意必须显式传
 * codeBlockLightTheme/codeBlockDarkTheme：不传时 stream-monaco 回退到 themes[0]（默认 vitesse-dark），
 * 浅色模式下代码块也会是深色。
 */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	const isDark = useThemeStore((s) => s.resolved === "dark");
	// 挂载初值锁定：流式中挂载 → 本次生命周期始终启用平滑（含固化后追平）；历史消息挂载 → 永不启用
	const smoothableRef = useRef<boolean>(Boolean(streaming) && !REDUCED_MOTION);
	return (
		<div className="markdown-body text-[14px] leading-relaxed text-ink select-text">
			{/* deferNodesUntilVisible=false：markstream 0.0.55 的延迟节点 bug——块数 > initialRenderBatchSize(40)
			    的节点先渲染为 node-placeholder 占位条，等 IntersectionObserver 标记可见后只写 ref 不触发
			    re-render（非虚拟化路径）；流式期间靠内容更新顺带刷新，流一停占位条就永久残留。 */}
			<MarkdownRender
				content={text}
				final={!streaming}
				fade={!REDUCED_MOTION}
				smoothStreaming={smoothableRef.current}
				smoothStreamingOptions={SMOOTH_OPTIONS}
				isDark={isDark}
				codeBlockLightTheme="vitesse-light"
				codeBlockDarkTheme="vitesse-dark"
				codeBlockProps={CODE_BLOCK_PROPS}
				deferNodesUntilVisible={false}
			/>
		</div>
	);
}
