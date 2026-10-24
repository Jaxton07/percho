/**
 * 插件主题表：宿主发布的**唯一**插件侧样式来源。
 *
 * 为什么是一张字符串而不是复用 globals.css：shadow root 里如果 adopt 宿主整份样式，
 * body/滚动条/聊天专用类这些内部实现全被拖进去，宿主一改就炸。这里只保留插件真正需要的
 * 三样东西：
 * 1. 令牌（`--p-*`）：与 globals.css 的语义 token 一一对应，暗色用 `:host-context` 切换
 *    （`:host-context` 是唯一能跨 shadow 边界读取宿主祖先属性的选择器，本项目只跑 Chromium）；
 * 2. `:host { all: initial }` 重置：断开通用的继承（font/color/line-height），插件页外观
 *    不再随宿主样式漂移，结果是确定的；
 * 3. 语义类（`.psection/.prow/.plabel/.phint/.pfield/...`）：设置页的行结构，宿主重设计
 *    只改这里，所有插件页跟着变 —— 这比让插件手抄 Tailwind 工具类可靠。
 *
 * 版本：改动语义类或令牌名 = 破坏性变更，同步把 PLUGIN_THEME_VERSION 加一。
 */

/** 主题表版本（写进 shadow host 的 data 属性，便于排查"插件页为什么是旧样式"） */
export const PLUGIN_THEME_VERSION = 1;

export const PLUGIN_THEME_CSS = `
:host {
	all: initial;
	/* 与 globals.css 浅色 token 对齐（改这里前先对齐那边的值） */
	--p-surface: #ffffff;
	--p-hover: #f4f4f5;
	--p-border: #e2e8f0;
	--p-border-strong: #cbd5e1;
	--p-ink: #18181b;
	--p-ink-2: #3f3f46;
	--p-ink-dim: #71717a;
	--p-ink-faint: #a1a1aa;
	--p-accent: #7c3aed;
	--p-on-accent: #ffffff;
	--p-err: #dc2626;
	--p-radius: 8px;
	/* 字号档位：镜像 src/styles/typography.css 的 --ui-* token（11/12/13px）。
	   这里用变量而不是往选择器里写 font-size 字面量：宿主有测试禁止产品源码写死字号，
	   而 shadow root 内又用不了宿主的 .text-ui-* 工具类，变量是两边都满足的唯一写法。 */
	/* 「all: initial」不重置自定义属性，所以 --fs-ui-scale（设置 → 外观 → 字号）能继承进来：
	   插件页字号必须跟着用户的字号档位走，否则同一个弹窗里两种大小。 */
	--p-fs-11: calc(11px * var(--fs-ui-scale, 1));
	--p-fs-12: calc(12px * var(--fs-ui-scale, 1));
	--p-fs-13: calc(13px * var(--fs-ui-scale, 1));
	display: block;
	box-sizing: border-box;
	color: var(--p-ink);
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
		"Hiragino Sans GB", "Microsoft YaHei", sans-serif;
	font-size: var(--p-fs-13);
	line-height: 1.55;
	-webkit-font-smoothing: antialiased;
}
:host([hidden]) { display: none; }
:host-context([data-theme="dark"]) {
	--p-surface: #212126;
	--p-hover: #2b2b31;
	--p-border: #38383f;
	--p-border-strong: #4b4b53;
	--p-ink: #e6e6ea;
	--p-ink-2: #c6c6cd;
	--p-ink-dim: #9a9aa3;
	--p-ink-faint: #6e6e77;
	--p-accent: #8b5cf6;
	--p-err: #f87171;
}
*, *::before, *::after { box-sizing: border-box; }
/* 分组：与宿主设置面板同一行距（gap-6） */
.psection { display: flex; flex-direction: column; gap: 24px; }
.pgroup { display: flex; flex-direction: column; gap: 12px; }
/* 一行设置：左标题右控件；窄容器自动折行 */
.prow { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.prow-start { align-items: flex-start; }
.pstack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ptitle { font-size: var(--p-fs-13); font-weight: 500; color: var(--p-ink); }
.phint { font-size: var(--p-fs-11); line-height: 1.45; color: var(--p-ink-faint); }
.pmuted { color: var(--p-ink-dim); font-size: var(--p-fs-12); }
.plist { display: flex; flex-direction: column; gap: 8px; }
.pcard {
	border: 1px solid var(--p-border);
	border-radius: 12px;
	padding: 12px;
	background: var(--p-surface);
}
.pdivider { height: 1px; background: var(--p-border); border: 0; margin: 0; }
/* 表单控件：尺寸/圆角/焦点环与宿主输入框一致 */
.pfield {
	width: 100%;
	min-width: 0;
	height: 28px;
	padding: 0 8px;
	border: 1px solid var(--p-border);
	border-radius: var(--p-radius);
	background: var(--p-surface);
	color: var(--p-ink);
	font-family: inherit;
	font-size: var(--p-fs-12);
	outline: none;
}
textarea.pfield { height: auto; min-height: 64px; padding: 6px 8px; resize: vertical; }
.pfield::placeholder { color: var(--p-ink-faint); }
.pfield:hover { border-color: var(--p-border-strong); }
.pfield:focus-visible { border-color: var(--p-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--p-accent) 25%, transparent); }
.pfield:disabled { opacity: 0.5; }
.pbtn {
	height: 28px;
	padding: 0 12px;
	border: 1px solid var(--p-border);
	border-radius: var(--p-radius);
	background: var(--p-surface);
	color: var(--p-ink);
	font-family: inherit;
	font-size: var(--p-fs-12);
	cursor: pointer;
}
.pbtn:hover { background: var(--p-hover); }
.pbtn-primary { background: var(--p-accent); border-color: var(--p-accent); color: var(--p-on-accent); }
.pbtn-primary:hover { filter: brightness(1.05); background: var(--p-accent); }
.pbtn:disabled { opacity: 0.5; cursor: default; }
/* 版式：form = 宿主内容区里正常流；full = 占满可用高度、插件自己滚 */
/* 覆盖在 pointer-events-none 容器（角区/overlay）时，内容自己开交互 */
.pinteractive { pointer-events: auto; }
.pform { display: block; }
.pfull { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.pfull-scroll { flex: 1; min-height: 0; overflow-y: auto; }
@media (prefers-reduced-motion: reduce) {
	.pbtn, .pfield { transition: none; }
}
`;
