import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initSplash } from "./splash";
import { useThemeStore } from "./stores/theme";
import "./styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// 开屏：同次运行已播过则立即移除，否则挂最长兜底（收場时机见 App.tsx 的 finishSplash）
initSplash();

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
