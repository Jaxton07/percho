import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "esbuild";

/**
 * 懒加载 esbuild + 打包态二进制路径修正（两件事必须一起做）：
 * - 打包态 esbuild 平台二进制在 app.asar 内无法 exec（spawn ENOTDIR），需指向 asarUnpack 镜像出的真实文件；
 * - esbuild 在**模块求值时**一次性缓存 ESBUILD_BINARY_PATH（main.js 顶层，0.25.x 见 main.js:1599），
 *   而 ESM import 提升会让静态 import 先于任何模块体执行 → 必须 import() 前动态设 env。
 * - env 用完即恢复原值：主进程的环境会被之后 spawn 的所有子进程继承（agent bash / MCP 等），
 *   仓库里其他版本的 esbuild（如 vite 内嵌的 0.28.x）读到指向旧二进制的 ESBUILD_BINARY_PATH 会直接崩
 *   （Host version does not match binary version）。求值在 import() resolve 前已完成，then 里恢复是安全时点。
 *   ⚠ 升级 esbuild 版本前先确认它仍是「求值时缓存 env」（若改为 spawn 时才读，恢复会让打包态回退到 asar 内路径）。
 * dev/测试态 unpacked 路径不存在 → 不设环境变量，esbuild 默认按包布局解析。
 */
let esbuildPromise: Promise<typeof import("esbuild")> | null = null;
/** internal：导出仅供 build-env.test.ts 验证 env 现场恢复 */
export function loadEsbuild(): Promise<typeof import("esbuild")> {
	if (!esbuildPromise) {
		const bin = process.platform === "win32" ? "esbuild.exe" : "esbuild";
		const unpacked = join(
			process.resourcesPath ?? "",
			`app.asar.unpacked/node_modules/@esbuild/${process.platform}-${process.arch}/bin/${bin}`,
		);
		const patched = existsSync(unpacked);
		const prev = process.env.ESBUILD_BINARY_PATH;
		if (patched) process.env.ESBUILD_BINARY_PATH = unpacked;
		esbuildPromise = import("esbuild").then((mod) => {
			if (patched) {
				// 求值已缓存 env → 恢复现场（用户预设过则还原，否则删除），防泄漏给子进程
				if (prev === undefined) delete process.env.ESBUILD_BINARY_PATH;
				else process.env.ESBUILD_BINARY_PATH = prev;
			}
			return mod;
		});
	}
	return esbuildPromise;
}

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
export const { useTranscriptStore, useSessionsStore, useUiStore, useProjectsStore, useSettingsStore, useUiPreferencesStore } = A.stores;`,
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
 * 静态资产 loader：插件可相对路径导入图片与音频（例 `import idleUrl from "./assets/idle.png"`、
 * `import chimeUrl from "./assets/done.mp3"`），esbuild 打成 data URL 内联进产物
 * （CSP img-src / media-src 均放行 data:）。非相对路径仍走裸导入拦截。
 * 音频体积注意：几秒语音的 mp3/m4a 约几十 KB，wav 动辄几 MB，建议有损格式。
 */
const ASSET_LOADERS: Record<string, "dataurl"> = {
	".png": "dataurl",
	".webp": "dataurl",
	".gif": "dataurl",
	".jpg": "dataurl",
	".jpeg": "dataurl",
	".mp3": "dataurl",
	".m4a": "dataurl",
	".aac": "dataurl",
	".ogg": "dataurl",
	".wav": "dataurl",
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
		const { build } = await loadEsbuild();
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
