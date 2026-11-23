import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { SettingsIcon } from "../icons/SettingsIcon";

/** A child of Settings: capture Escape before the parent and restore its focus on exit. */
export function RemoteModal({
	title,
	children,
	footer,
	onClose,
	locked = false,
}: {
	title: string;
	children: ReactNode;
	footer: ReactNode;
	onClose: () => void;
	locked?: boolean;
}) {
	const ref = useRef<HTMLElement>(null);
	const close = useRef(onClose);
	const lockedRef = useRef(locked);
	close.current = onClose;
	lockedRef.current = locked;
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const parent = (previous?.closest('[role="dialog"]') ??
			document.querySelector('[role="dialog"]')) as HTMLElement | null;
		const wasInert = parent?.inert;
		if (parent) parent.inert = true;
		const frame = requestAnimationFrame(() => {
			const modal = ref.current;
			(
				modal?.querySelector<HTMLElement>("[data-initial-focus]") ??
				modal?.querySelector<HTMLElement>("input:not(:disabled)") ??
				modal?.querySelector<HTMLElement>("button:not(:disabled)")
			)?.focus();
		});
		const key = (event: KeyboardEvent) => {
			const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(
				(item) => !item.inert,
			);
			if (dialogs.at(-1) !== ref.current) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (!lockedRef.current) close.current();
			}
			if (event.key !== "Tab") return;
			const items = [
				...(ref.current?.querySelectorAll<HTMLElement>(
					'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
				) ?? []),
			];
			if (!items.length) {
				event.preventDefault();
				return;
			}
			const index = items.indexOf(document.activeElement as HTMLElement);
			if (event.shiftKey && index <= 0) {
				event.preventDefault();
				items.at(-1)?.focus();
			} else if (!event.shiftKey && (index === -1 || index === items.length - 1)) {
				event.preventDefault();
				items[0]?.focus();
			}
		};
		document.addEventListener("keydown", key, true);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("keydown", key, true);
			if (parent) parent.inert = !!wasInert;
			if (
				previous?.isConnected &&
				previous !== document.body &&
				previous !== document.documentElement &&
				!previous.matches(":disabled") &&
				!previous.closest("[inert]")
			) {
				previous.focus();
			} else document.querySelector<HTMLElement>(".remote-list-header button:not(:disabled)")?.focus();
		};
	}, []);
	const t = useT();
	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: The backdrop offers the same optional dismissal as Escape.
		<div
			className="remote-overlay"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !locked) onClose();
			}}
		>
			<section ref={ref} role="dialog" aria-modal="true" aria-label={title} className="remote-modal">
				<header className="remote-modal-head">
					<h2 className="text-ui-18 font-semibold">{title}</h2>
					<button
						type="button"
						disabled={locked}
						aria-label={t("common.cancel")}
						onClick={onClose}
						className="remote-icon"
					>
						<SettingsIcon name="close" />
					</button>
				</header>
				<div className="remote-modal-body">{children}</div>
				<footer className="remote-modal-footer">{footer}</footer>
			</section>
		</div>,
		document.body,
	);
}
