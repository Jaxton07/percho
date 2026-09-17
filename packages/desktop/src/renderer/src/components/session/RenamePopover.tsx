import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { type MenuAnchor, placeMenu } from "../ui/place-menu";

/** 退场时长：必须与 globals.css 的 .pop-out（120ms）一致 —— 动画跑完前卸载会闪回（PreviewTicker 同坑） */
const EXIT_MS = 120;

/**
 * 会话重命名浮层：锚在胶囊下沿展开（比菜单低 8px），进场 160ms pop-in / 退场 120ms pop-out。
 * 提交 = Enter / 「重命名」/ 点浮层外（与系统重命名一致）；取消 = Esc / 「取消」；
 * 空值提交 = 保持原名（调用方兜底，这里原样回传 trim 后的文本）。
 */
export function RenamePopover({
	anchor,
	value,
	onCommit,
	onCancel,
}: {
	anchor: MenuAnchor;
	value: string;
	onCommit: (name: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [text, setText] = useState(value);
	/** 退场动画进行中：锁住输入与提交入口，等动画跑完再落地回调 */
	const [closing, setClosing] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	// 打开即聚焦并全选。不用 autoFocus：选中菜单项后那一层已卸载，浏览器会把焦点丢回 body，
	// autoFocus 在 commit 阶段抛出的 focus() 会被随后的 click 收尾抹掉（实测 focused=false）→ 等一帧手动聚焦
	useEffect(() => {
		const id = requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
		return () => cancelAnimationFrame(id);
	}, []);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		setPos(
			placeMenu(
				anchor,
				{ width, height },
				{ width: window.innerWidth, height: window.innerHeight },
				{ gap: 8 },
			),
		);
	}, [anchor]);

	const finish = (commit: boolean) => {
		if (closing) return;
		setClosing(true);
		// reduced-motion 下 CSS 已跳终态，这里照常等满 120ms（只是卸载晚一点，不会闪回）
		window.setTimeout(() => {
			if (commit) onCommit(text.trim());
			else onCancel();
		}, EXIT_MS);
	};
	// 监听器只挂一次：finish 闭包有每次都变的 text/closing，用 ref 拿最新版（直接依赖 finish 会导致每敲一键重挂两个 window 监听）
	const finishRef = useRef(finish);
	finishRef.current = finish;

	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current?.contains(e.target as Node)) return;
			// 点浮层外 = 提交（与系统重命名一致）
			finishRef.current(true);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				finishRef.current(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	return createPortal(
		<div
			ref={ref}
			className={`no-drag fixed z-50 w-[264px] rounded-xl bg-surface p-2.5 shadow-dialog ${
				closing ? "pop-out" : "pop-in"
			}`}
			style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }}
		>
			<input
				ref={inputRef}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") finish(true);
				}}
				placeholder={t("tabbar.renamePlaceholder")}
				className="w-full rounded-lg bg-hover px-2.5 py-[7px] text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
			/>
			<div className="mt-2 flex justify-end gap-0.5">
				<button
					type="button"
					className="rounded-lg px-2 py-1 text-[13px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					onClick={() => finish(false)}
				>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					className="rounded-lg px-2 py-1 text-[13px] font-medium text-ink transition-colors hover:bg-hover"
					onClick={() => finish(true)}
				>
					{t("tabbar.rename")}
				</button>
			</div>
		</div>,
		document.body,
	);
}
