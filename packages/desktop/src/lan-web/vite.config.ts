import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const stub = r("./src/empty-stub.ts");

/**
 * lan-web 独立 vite 构建（不在 electron-vite 三管线内）：
 * 单文件产物（?raw 内联进 main bundle，沿用 P1 D7 机制，免 extraResources）。
 * markstream-react 的 optional peer 全部 alias 到空 stub 裁体积；
 * 构建产物 = dist/lan-web/index.html（单 HTML，无外部 chunk）。
 */
export default defineConfig({
	// root 独立：在 packages/desktop 下跑 npx vite build --config 时，cwd 是 desktop 而非本目录
	root: r("./"),
	plugins: [react(), viteSingleFile()],
	resolve: {
		alias: [
			{ find: /^stream-monaco$/, replacement: stub },
			{ find: /^monaco-editor$/, replacement: stub },
			{ find: /^mermaid$/, replacement: stub },
			{ find: /^katex.*$/, replacement: stub },
			{ find: /^@antv\/infographic$/, replacement: stub },
			{ find: /^@terrastruct\/d2$/, replacement: stub },
			{ find: "@percho/shared", replacement: r("../../../shared/src/index.ts") },
		],
	},
	build: {
		outDir: r("./dist/lan-web"),
		emptyOutDir: true,
		rollupOptions: {
			// markstream-react 0.0.55 dist 为二次打包产物，/* @__PURE__ */ 注释漂移到语句末尾，
			// Rollup 无法解释该位置的注解（INVALID_ANNOTATION），删注释只丢 tree-shaking hint，无正确性影响，静音
			onwarn(warning, warn) {
				if (warning.code === "INVALID_ANNOTATION") return;
				warn(warning);
			},
		},
	},
});
