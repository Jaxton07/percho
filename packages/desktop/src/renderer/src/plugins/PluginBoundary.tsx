import { Component, type ReactNode } from "react";
import { getPi } from "../api";
import { useUiPluginRegistry } from "./registry";

interface PluginBoundaryProps {
	pluginName: string;
	/** 崩溃日志里的定位标签（槽位名 / 区域名 / 设置分类 id） */
	label: string;
	/**
	 * 崩溃后的兜底渲染。
	 * Slot 传默认组件实例（兜底即默认 UI，永不白屏）；contribution 不传 → 渲染 null
	 * （没有默认可回退，spec §15）。key 由调用点负责（pluginName:loadNonce，热重载换新实例）。
	 */
	fallback?: ReactNode;
	children: ReactNode;
}

interface PluginBoundaryState {
	errored: boolean;
}

/**
 * 插件错误边界（Slot 与 RegionHost 共用）：崩溃 → 渲染 fallback（无则 null）并上报崩溃计数；
 * 达阈值自动禁用（IPC 落盘 + console 警告）。计数与禁用按插件共享（槽位与贡献同一套）。
 */
class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
	state: PluginBoundaryState = { errored: false };

	static getDerivedStateFromError(): PluginBoundaryState {
		return { errored: true };
	}

	componentDidCatch(error: unknown) {
		const { pluginName, label } = this.props;
		console.error(`[ui-plugins] 插件 ${pluginName} 在 ${label} 崩溃`, error);
		if (useUiPluginRegistry.getState().reportCrash(pluginName)) {
			console.warn(`[ui-plugins] 插件 ${pluginName} 连续崩溃达到阈值，自动禁用`);
			void getPi().uiPluginsSetPluginEnabled(pluginName, false);
		}
	}

	render() {
		return this.state.errored ? (this.props.fallback ?? null) : this.props.children;
	}
}

export { PluginBoundary };
