import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin({ exclude: ["@percho/backend", "@percho/shared"] })],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/main/index.ts"),
					"session-media-worker": resolve(__dirname, "../backend/src/session/media-maintenance-worker.ts"),
					"session-catalog-worker": resolve(__dirname, "../backend/src/session/catalog-worker.ts"),
				},
				output: {
					entryFileNames: (chunk) => (chunk.name.endsWith("-worker") ? "[name].mjs" : "[name].js"),
				},
				external: ["@earendil-works/pi-coding-agent"],
			},
		},
		resolve: {
			alias: {
				"@percho/backend": resolve(__dirname, "../backend/src/index.ts"),
				"@percho/shared": resolve(__dirname, "../shared/src/index.ts"),
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ["@percho/shared"] })],
		build: {
			rollupOptions: {
				output: {
					format: "cjs",
					entryFileNames: "index.cjs",
				},
			},
		},
		resolve: {
			alias: {
				"@percho/shared": resolve(__dirname, "../shared/src/index.ts"),
			},
		},
	},
	renderer: {
		resolve: {
			alias: {
				"@percho/shared": resolve(__dirname, "../shared/src/index.ts"),
				"@renderer": resolve(__dirname, "src/renderer/src"),
			},
		},
		plugins: [react(), tailwindcss()],
	},
});
