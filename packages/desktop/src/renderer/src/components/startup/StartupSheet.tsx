import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/Button";

/** Native modal focus containment; only the body scrolls. */
export function StartupSheet({
	title,
	children,
	closeLabel,
	onClose,
	action,
}: {
	title: string;
	children: ReactNode;
	closeLabel: string;
	onClose: () => void;
	action?: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		const previous = document.activeElement;
		dialog?.showModal();
		return () => {
			dialog?.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
		};
	}, []);
	return createPortal(
		<dialog
			ref={ref}
			className="startup-sheet rounded-xl border-0 bg-surface p-0 text-ink-2 shadow-dialog"
			aria-labelledby="startup-sheet-title"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onPointerDown={(event) => {
				if (event.target !== event.currentTarget) return;
				const rect = event.currentTarget.getBoundingClientRect();
				if (
					event.clientX < rect.left ||
					event.clientX > rect.right ||
					event.clientY < rect.top ||
					event.clientY > rect.bottom
				)
					onClose();
			}}
		>
			<h2 id="startup-sheet-title" className="px-6 pt-5 pb-3 text-ui-14 font-medium">
				{title}
			</h2>
			<div className="startup-sheet-body px-6 pb-3 text-ui-12 text-ink-dim">{children}</div>
			<div className="flex shrink-0 items-center justify-end gap-2 px-4 pt-2 pb-4">
				{action}
				<Button onClick={onClose} className="font-medium">
					{closeLabel}
				</Button>
			</div>
		</dialog>,
		document.body,
	);
}
