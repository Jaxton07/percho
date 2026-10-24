import { PLUGIN_THEME_CSS } from "./plugin-theme";

/**
 * 插件构建产物的附属资源（perchoUi 2 的 manifest.styles → dist/index.css）。
 *
 * loader 读完 `uiPluginsReadCode` 后把 css 放进来，ShadowSurface 挂载时取。
 * 为什么放模块级 Map 而不是 store：它随插件代码一起替换（重建 → changed 事件 → 重新读），
 * 属于加载期资源、不参与渲染响应性；放 store 里反而会让每次重载触发一次无意义的 re-render。
 */
const cssByPlugin = new Map<string, string>();

export function setPluginCss(name: string, css: string | undefined): void {
	if (css && css.trim().length > 0) cssByPlugin.set(name, css);
	else cssByPlugin.delete(name);
}

export function getPluginCss(name: string): string | undefined {
	return cssByPlugin.get(name);
}

/**
 * css 文本 → CSSStyleSheet（constructable stylesheet，供 adoptedStyleSheets 复用）。
 * 同一个文本只解析一次：切分类来回挂载同一个插件时不必重复解析。
 * 环境不支持（jsdom / 旧内核）或解析失败 → 返回 null，调用方降级到 light DOM。
 */
const sheetCache = new Map<string, CSSStyleSheet | null>();

/** 缓存上限：插件反复重建会不断产生新文本，超了整表清空（只影响解析次数，不影响正确性） */
const SHEET_CACHE_MAX = 64;

export function sheetOf(css: string): CSSStyleSheet | null {
	const cached = sheetCache.get(css);
	if (cached !== undefined) return cached;
	let sheet: CSSStyleSheet | null = null;
	try {
		if (typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
			sheet = new CSSStyleSheet();
			sheet.replaceSync(css);
		}
	} catch (err) {
		console.warn("[ui-plugins] 样式表解析失败，插件页降级到 light DOM", err);
		sheet = null;
	}
	if (sheetCache.size >= SHEET_CACHE_MAX) sheetCache.clear();
	sheetCache.set(css, sheet);
	return sheet;
}

/** 主题表 sheet（同样是构造式，全局共享一份） */
export function themeSheet(): CSSStyleSheet | null {
	return sheetOf(PLUGIN_THEME_CSS);
}
