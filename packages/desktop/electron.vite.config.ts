import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin({ exclude: ["@pi-desktop/backend", "@pi-desktop/shared"] })],
		build: {
			rollupOptions: {
				external: ["@earendil-works/pi-coding-agent"],
			},
		},
		resolve: {
			alias: {
				"@pi-desktop/backend": resolve(__dirname, "../backend/src/index.ts"),
				"@pi-desktop/shared": resolve(__dirname, "../shared/src/index.ts"),
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ["@pi-desktop/shared"] })],
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
				"@pi-desktop/shared": resolve(__dirname, "../shared/src/index.ts"),
			},
		},
	},
	renderer: {
		resolve: {
			alias: {
				"@pi-desktop/shared": resolve(__dirname, "../shared/src/index.ts"),
				"@renderer": resolve(__dirname, "src/renderer/src"),
			},
		},
		plugins: [react(), tailwindcss()],
	},
});
