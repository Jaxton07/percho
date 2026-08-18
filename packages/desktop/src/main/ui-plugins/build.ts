import { join } from "node:path";
import type { Plugin } from "esbuild";
import { build } from "esbuild";

/**
 * 宿主 API 暴露面（四个虚拟模块的 shim 重写目标 = window.PerchoUI）。
 * 与 renderer 的 plugins/host-api.ts、Phase 2 的 resources/ui-plugins/percho-ui.d.ts
 * **逐名一致**（agent 写代码的类型来源就是 percho-ui.d.ts，错一个名字 agent 就会写出跑不起来的插件）。
 * 新增暴露 = 改这三处 + host-api.ts + shim + percho-ui.d.ts，同步进行。
 */
const SHIMS: Record<string, string> = {
	// react：整个命名空间对象给到插件（与宿主同一实例）
	react: `
const R = window.PerchoUI.React;
export default R;
export const { Children, Component, Fragment, PureComponent, StrictMode, Suspense,
  cloneElement, createContext, createElement, createRef, forwardRef, isValidElement,
  lazy, memo, startTransition, use, useActionState, useCallback, useContext,
  useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle,
  useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef,
  useState, useSyncExternalStore, useTransition, version } = R;`,
	// react/jsx-runtime：jsx automatic runtime 自动 import 这个 specifier，同样被重写
	"react/jsx-runtime": `
const J = window.PerchoUI.jsxRuntime;
export const { jsx, jsxs, Fragment } = J;`,
	// react-dom（一般不需要；给了 createPortal 足以做弹层）
	"react-dom": `
const D = window.PerchoUI.ReactDOM;
export default D;
export const { createPortal, flushSync } = D;`,
	// @percho/plugin-api：宿主精选子集
	"@percho/plugin-api": `
const A = window.PerchoUI;
export default A;
export const { version, components, helpers, hooks, stores } = A;
export const { Button, Dropdown, Tooltip, Markdown, ImagePreview } = A.components;
export const { summarizeArgs, displayToolName } = A.helpers;
export const { useT, useContextUsage, useLanguage } = A.hooks;
export const { useTranscriptStore, useSessionsStore, useUiStore, useProjectsStore, useSettingsStore } = A.stores;`,
};

/**
 * externals 重写：react / react/jsx-runtime / react-dom / @percho/plugin-api
 * 重定向到 percho-external namespace，onLoad 返回从 window.PerchoUI 再导出的 shim。
 * 产物里不允许出现任何裸导入符（sandbox renderer 无 import map、无 node_modules 解析）。
 */
const perchoExternalsPlugin: Plugin = {
	name: "percho-externals",
	setup(build) {
		build.onResolve({ filter: /^(react|react\/jsx-runtime|react-dom|@percho\/plugin-api)$/ }, (args) => ({
			path: args.path,
			namespace: "percho-external",
		}));
		build.onLoad({ filter: /.*/, namespace: "percho-external" }, (args) => ({
			contents: SHIMS[args.path],
			loader: "js",
		}));
	},
};

/**
 * 静态资产 loader：插件可相对路径导入图片（例 `import idleUrl from "./assets/idle.png"`），
 * esbuild 打成 data URL 内联进产物（CSP img-src 放行 data:）。非相对路径仍走裸导入拦截。
 */
const ASSET_LOADERS: Record<string, "dataurl"> = {
	".png": "dataurl",
	".webp": "dataurl",
	".gif": "dataurl",
	".jpg": "dataurl",
	".jpeg": "dataurl",
};

/**
 * 构建一个插件：src → dist/index.js（bundle + externals 重写）。
 * 失败时返回首条错误的 text + location 拼成的单行字符串（旧产物保留，调用方决定是否继续生效）。
 */
export async function buildPlugin(
	pluginDir: string,
	mainEntry: string,
	options?: { outDir?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
	// 产物目录：默认插件目录内 dist/；内置插件（resources 只读）由 manager 指定 userData 版本化缓存目录
	const outDir = options?.outDir ?? join(pluginDir, "dist");
	try {
		await build({
			entryPoints: [join(pluginDir, mainEntry)],
			bundle: true,
			format: "esm",
			outfile: join(outDir, "index.js"),
			jsx: "automatic", // 自动 runtime → import 自 react/jsx-runtime，同样被重写
			platform: "browser",
			target: "chrome140",
			sourcemap: false,
			minify: false, // 方便用户/排查
			logLevel: "silent", // 错误由我们捕获结构化，不打 console
			loader: ASSET_LOADERS,
			plugins: [perchoExternalsPlugin],
		});
		return { ok: true };
	} catch (err) {
		const esbuildErr = err as {
			errors?: { text?: string; location?: { file?: string; line?: number; column?: number } }[];
		};
		const first = esbuildErr.errors?.[0];
		const text = first?.text ?? String(err);
		const location = first?.location
			? ` (${first.location.file}:${first.location.line}:${first.location.column})`
			: "";
		return { ok: false, error: `${text}${location}`.replace(/\n/g, " ").slice(0, 500) };
	}
}
