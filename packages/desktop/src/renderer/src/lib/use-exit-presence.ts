import { type RefObject, useLayoutEffect, useState } from "react";

function milliseconds(value: string): number {
	const n = Number.parseFloat(value);
	return Number.isFinite(n) ? n * (value.trim().endsWith("ms") ? 1 : 1000) : 0;
}
export function transitionMilliseconds(
	style: Pick<CSSStyleDeclaration, "transitionProperty" | "transitionDuration" | "transitionDelay">,
	property: string,
): number {
	const properties = style.transitionProperty.split(",");
	const durations = style.transitionDuration.split(",");
	const delays = style.transitionDelay.split(",");
	return Math.max(
		0,
		...properties.map((p, i) =>
			p.trim() === property || p.trim() === "all"
				? milliseconds(durations[i % durations.length] ?? "0s") +
					milliseconds(delays[i % delays.length] ?? "0s")
				: 0,
		),
	);
}

/** Keep the existing closing transition; every reopen invalidates the previous release. */
export function useExitPresence(
	open: boolean,
	ref: RefObject<HTMLElement | null>,
	property: string,
	pseudo?: string,
): boolean {
	const [mounted, setMounted] = useState(open);
	useLayoutEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		const element = ref.current;
		if (!mounted || !element) return;
		const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches
			? 0
			: transitionMilliseconds(getComputedStyle(element, pseudo), property);
		if (duration <= 0) {
			setMounted(false);
			return;
		}
		let valid = true;
		const release = () => {
			if (valid) setMounted(false);
		};
		const finish = (event: TransitionEvent) => {
			if (
				event.target === element &&
				event.propertyName === property &&
				(event.pseudoElement || undefined) === pseudo
			)
				release();
		};
		element.addEventListener("transitionend", finish);
		element.addEventListener("transitioncancel", finish);
		const timer = window.setTimeout(release, duration + 50);
		return () => {
			valid = false;
			clearTimeout(timer);
			element.removeEventListener("transitionend", finish);
			element.removeEventListener("transitioncancel", finish);
		};
	}, [open, mounted, ref, property, pseudo]);
	return open || mounted;
}
