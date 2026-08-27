import { type MessageKey, useT } from "../i18n";
import { useToastsStore } from "../stores/toasts";
import { CloseIcon, ErrorCircleIcon } from "./icons";

/**
 * 全局 Toast 栈（error-system 画板 ⑥⑦）：顶栏右侧浮动，surface+shadow-pop 无边框悬浮卡，
 * 仅一枚 severity glyph，× 常态 40% hover 实。自动消失（store 层 4.5s），点 × 立即关。
 *
 * 挂载在 App 根（聊天页/项目页/设置共层）；只承接「无需用户现场处置」的通知，
 * 会话内错误走错误卡、发送失败走 Composer 内联条，都不要走这里。
 */
export function Toaster() {
	const t = useT();
	const toasts = useToastsStore((s) => s.toasts);
	const dismiss = useToastsStore((s) => s.dismiss);

	if (toasts.length === 0) return null;
	return (
		<div className="pointer-events-none fixed right-4 top-14 z-50 flex w-[330px] flex-col gap-2.5">
			{toasts.map((toast) => (
				<div key={toast.id} className="toast">
					<span
						className={`t-glyph ${toast.severity === "error" ? "text-err" : toast.severity === "warning" ? "text-warn" : "text-info"}`}
					>
						<ErrorCircleIcon />
					</span>
					<div className="min-w-0">
						<div className="t-title">{t(toast.titleKey as MessageKey)}</div>
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
		</div>
	);
}
