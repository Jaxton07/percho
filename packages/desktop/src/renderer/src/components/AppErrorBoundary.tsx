import { Component, type ErrorInfo, type ReactNode } from "react";
import { type MessageKey, useT } from "../i18n";

type TFunc = (key: MessageKey, params?: Record<string, string | number>) => string;

interface State {
	error: Error | null;
}

/** 兜底 UI：整屏提示 + 重新加载按钮（错误信息随 console.error 进 main 日志便于定位） */
class ErrorFallback extends Component<{ error: Error; t: TFunc }> {
	render() {
		const { error, t } = this.props;
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
				<div className="text-[13px] font-medium text-ink">{t("appError.title")}</div>
				<p className="max-w-md text-[12px] leading-relaxed text-ink-faint">
					{t("appError.desc", { detail: String(error.message ?? error) })}
				</p>
				<button
					type="button"
					onClick={() => window.location.reload()}
					className="rounded-lg bg-ink px-4 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-80"
				>
					{t("appError.reload")}
				</button>
			</div>
		);
	}
}

/**
 * 全局错误边界：任何渲染期异常（含 React #185 无限渲染）都落到这里，
 * 显示可恢复的提示页而不是整窗白屏。componentDidCatch 的 console.error
 * 会经 renderer console 转发通道把 error + componentStack 打进 main 日志，
 * 下次崩溃可直接定位组件。
 */
class BoundaryInner extends Component<{ children: ReactNode; t: TFunc }, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[app-error-boundary]", error, info.componentStack);
	}

	render() {
		if (!this.state.error) return this.props.children;
		return <ErrorFallback error={this.state.error} t={this.props.t} />;
	}
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
	const t = useT();
	return <BoundaryInner t={t}>{children}</BoundaryInner>;
}
