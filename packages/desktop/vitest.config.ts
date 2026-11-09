import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		// 客户端回归测试需拦截 markstream 动态加载的浏览器编辑器。
		server: { deps: { inline: [/markstream-react/] } },
	},
});
