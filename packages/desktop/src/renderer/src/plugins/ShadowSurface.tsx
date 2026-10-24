import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getPluginCss, sheetOf, themeSheet } from "./plugin-assets";
import { PLUGIN_THEME_VERSION } from "./plugin-theme";

interface ShadowSurfaceProps {
	pluginName: string;
	/** 崩溃/降级日志里的定位标签（区域名 / 设置分类 id） */
	label: string;
	/** 版式（manifest contribution.layout）：form = 宿主内容区里正常流；full = 占满高度自己滚 */
	layout: "form" | "full";
	children: ReactNode;
}

/**
 * 插件隔离面：把插件贡献挂进 shadow root。
 *
 * 三条硬保证：
 * 1. **样式不外泄**：插件自带 CSS（manifest.styles）只注入自己的 shadow root；
 * 2. **宿主改不动它、它也改不动宿主**：`:host { all: initial }` + 主题表，插件页外观与宿主
 *    CSS 漂移解耦（代价：shadow 里没有宿主 Tailwind 工具类，用主题表的 `.p*` 语义类）；
 * 3. **撑不破布局**：host 元素上 `contain: layout paint style`，插件既不能把设置弹窗顶爆，
 *    `position: fixed` 也逃不出这个容器。
 *
 * 降级：`attachShadow` / 构造式样式表不可用（jsdom、旧内核）或抛错 → 退回 light DOM 直接渲染，
 * 只丢隔离、不丢功能，并留一条 console 警告便于排查。
 */
export function ShadowSurface({ pluginName, label, layout, children }: ShadowSurfaceProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [mount, setMount] = useState<HTMLElement | null>(null);
	const [isolated, setIsolated] = useState(true);
	const css = getPluginCss(pluginName);

	useLayoutEffect(() => {
		const el = hostRef.current;
		if (!el) return;
		const theme = themeSheet();
		if (!theme) {
			// 环境不支持构造式样式表：隔离无意义（没有主题表插件页会是白纸），直接降级
			setIsolated(false);
			setMount(null);
			return;
		}
		try {
			// StrictMode 双执行 / 切换版式后复用：已有 shadowRoot 就复用，不重复 attach
			const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
			const sheets = [theme];
			const pluginSheet = css ? sheetOf(css) : null;
			if (pluginSheet) sheets.push(pluginSheet);
			shadow.adoptedStyleSheets = sheets;
			const next = document.createElement("div");
			next.className = layout === "full" ? "pfull" : "pform";
			next.setAttribute("data-percho-plugin", pluginName);
			shadow.replaceChildren(next);
			setIsolated(true);
			setMount(next);
		} catch (err) {
			console.error(`[ui-plugins] ${pluginName} 在 ${label} 的 shadow 隔离不可用，降级 light DOM`, err);
			setIsolated(false);
			setMount(null);
		}
	}, [pluginName, label, layout, css]);

	// 卸载时清掉缓存里的挂载点引用（元素本身随 DOM 移除，这里只是避免 stale state 警告）
	useEffect(() => () => setMount(null), []);

	return (
		<div
			ref={hostRef}
			data-plugin={pluginName}
			data-percho-surface={isolated ? "shadow" : "light"}
			data-percho-theme={isolated ? String(PLUGIN_THEME_VERSION) : undefined}
			style={isolated ? { display: "block", contain: "layout paint style" } : undefined}
			className={layout === "full" ? "flex h-full min-h-0 flex-col" : undefined}
		>
			{isolated ? null : children}
			{mount ? createPortal(children, mount) : null}
		</div>
	);
}
