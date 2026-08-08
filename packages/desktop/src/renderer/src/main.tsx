import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { useThemeStore } from "./stores/theme";
import "./styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// render 前先恢复主题/背景（一次 IPC），避免深色模式启动闪白
void useThemeStore
	.getState()
	.init()
	.finally(() => {
		createRoot(root).render(
			<StrictMode>
				<App />
			</StrictMode>,
		);
	});
