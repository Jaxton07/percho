import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 首帧前按系统偏好写 data-theme（styles.css 的 token 切换源；App 内 useIsDark 跟随系统变化）
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches
	? "dark"
	: "light";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
