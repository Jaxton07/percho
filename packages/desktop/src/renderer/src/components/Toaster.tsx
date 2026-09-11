import { type MessageKey, useT } from "../i18n";
import { useToastsStore } from "../stores/toasts";
import { CloseIcon, ErrorCircleIcon, InfoIcon, WarningIcon } from "./icons";

/** severity glyph：error=「!」包 / warning=三角 / info=「i」包（ink-faint 近乎隐形，error-system 画板⑥） */
function SeverityGlyph({ severity }: { severity: "error" | "warning" | "info" }) {
	if (severity === "warning") {
		return (
			<span className="t-glyph text-warn">
				<WarningIcon />
			</span>
		);
	}
	if (severity === "info") {
		return (
			<span className="t-glyph text-info">
				<InfoIcon />
			</span>
		);
	}
	return (
		<span className="t-glyph text-err">
			<ErrorCircleIcon />
		</span>
	);
}

/**
 * 全局 Toast 栈（error-system 画板 ⑥⑦ + extension-dialogs 画板⑨）：顶栏右侧浮动，
 * surface+shadow-pop 无边框悬浮卡，仅一枚 severity glyph，× 常态 40% hover 实。
 * 应用 toast 走 i18n titleKey；扩展 notify 走原文 titleText + 来源副标题，超出可见栈
 * 上限的折叠为一行注脚（store 层限流，本组件只显示 overflowCount）。
 *
 * 挂载在 App 根（聊天页/项目页/设置共层）；只承接「无需用户现场处置」的通知，
 * 会话内错误走错误卡、发送失败走 Composer 内联条，都不要走这里。
 */
export function Toaster() {
	const t = useT();
	const toasts = useToastsStore((s) => s.toasts);
	const overflowCount = useToastsStore((s) => s.overflowCount);
	const dismiss = useToastsStore((s) => s.dismiss);

	if (toasts.length === 0 && overflowCount === 0) return null;
	return (
		<div className="pointer-events-none fixed right-4 top-14 z-50 flex w-[330px] flex-col gap-2.5">
			{toasts.map((toast) => (
				<div key={toast.id} className="toast">
					<SeverityGlyph severity={toast.severity} />
					<div className="min-w-0">
						<div className="t-title">
							{toast.titleText !== undefined ? toast.titleText : t(toast.titleKey as MessageKey)}
						</div>
						{toast.detail && <div className="t-sub truncate">{toast.detail}</div>}
					</div>
					<button
						type="button"
						className="t-x"
						aria-label={t("common.close")}
						onClick={() => dismiss(toast.id)}
					>
						<CloseIcon />
					</button>
				</div>
			))}
			{overflowCount > 0 && (
				<div className="toast-overflow">
					<InfoIcon size={11} />
					{t("toast.overflowCollapsed", { count: overflowCount })}
				</div>
			)}
		</div>
	);
}
