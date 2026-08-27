import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
// 宿主 API 挂载（副作用）：必须在任何插件代码可能运行之前执行，因此置于 theme store init 之前
import "./plugins/host-api";
// monaco 缺失服务补注册（副作用，详见文件头）：代码块编辑器 UNKNOWN service 报错修复
import "./monaco-contribs";
import { initSplash } from "./splash";
import { useThemeStore } from "./stores/theme";
import { useUiPreferencesStore } from "./stores/ui-preferences";
import "./styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// 开屏：同次运行已播过则立即移除，否则挂最长兜底（收場时机见 App.tsx 的 finishSplash）
initSplash();

// render 前先恢复主题/背景/UI 偏好（一次 IPC），避免深色模式启动闪白与轨道开关闪现
void Promise.all([useThemeStore.getState().init(), useUiPreferencesStore.getState().init()]).finally(() => {
	createRoot(root).render(
		<StrictMode>
			{/* 全局边界：渲染期异常（含 #185 无限更新类）落到可恢复错误页而非整窗白屏 */}
			<AppErrorBoundary>
				<App />
			</AppErrorBoundary>
		</StrictMode>,
	);
});
