import {
	createContext,
	forwardRef,
	type MouseEventHandler,
	type ReactNode,
	type Ref,
	useContext,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { clearSelectionWithin } from "../../lib/clear-selection-within";
import { useExitPresence } from "../../lib/use-exit-presence";
import { useSessionViewStore } from "../../stores/session-view";

export const SessionViewContext = createContext<string | null>(null);

export function useDetailValue(key: string, fallback = false): [boolean, (open: boolean) => void] {
	const sessionId = useContext(SessionViewContext);
	const saved = useSessionViewStore((s) => {
		const details = sessionId ? s.bySession[sessionId]?.details : undefined;
		return details?.[key];
	});
	const [local, setLocal] = useState(fallback);
	useLayoutEffect(() => {
		if (sessionId && fallback && saved === undefined && useSessionViewStore.getState().bySession[sessionId]) {
			useSessionViewStore.getState().setDetail(sessionId, key, true);
		}
	}, [sessionId, key, fallback, saved]);
	return [
		saved ?? local,
		(open) => {
			if (sessionId) useSessionViewStore.getState().setDetail(sessionId, key, open);
			else setLocal(open);
		},
	];
}

export interface DeferredDetailsProps {
	viewKey?: string;
	className?: string;
	summaryClassName?: string;
	bodyClassName?: string;
	defaultOpen?: boolean;
	summary: ReactNode;
	summaryRef?: Ref<HTMLElement>;
	summaryOnContextMenu?: MouseEventHandler<HTMLElement>;
	children: ReactNode | (() => ReactNode);
	sectionKey?: string;
}

/** Native details semantics/animation, with no expensive child tree while closed. */
export const DeferredDetails = forwardRef<HTMLDetailsElement, DeferredDetailsProps>(function DeferredDetails(
	{
		viewKey,
		className,
		summaryClassName,
		bodyClassName,
		defaultOpen = false,
		summary,
		summaryRef,
		summaryOnContextMenu,
		children,
		sectionKey,
	},
	forwarded,
) {
	const localKey = useId();
	const [open, setOpen] = useDetailValue(viewKey ?? localKey, defaultOpen);
	const ref = useRef<HTMLDetailsElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	useImperativeHandle(forwarded, () => ref.current as HTMLDetailsElement);
	const present = useExitPresence(open, ref, "height", "::details-content");
	useLayoutEffect(() => {
		if (open || !bodyRef.current) return;
		const body = bodyRef.current;
		clearSelectionWithin(body);
		if (body.contains(document.activeElement))
			ref.current?.querySelector("summary")?.focus({ preventScroll: true });
	}, [open]);
	return (
		<details
			ref={ref}
			className={className}
			open={open}
			data-section-key={sectionKey}
			data-view-key={viewKey}
			onToggle={(event) => {
				if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
			}}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 原生 summary 自带键盘激活；点击接入受控展开状态 */}
			<summary
				ref={summaryRef}
				className={summaryClassName}
				onContextMenu={summaryOnContextMenu}
				onClick={(event) => {
					if (
						event.button !== 0 ||
						(event.target instanceof Element && event.target.closest("button,a,input,select,textarea"))
					)
						return;
					event.preventDefault();
					setOpen(!open);
				}}
			>
				{summary}
			</summary>
			{present && (
				<div ref={bodyRef} className={bodyClassName} data-detail-body="" inert={!open}>
					{typeof children === "function" ? children() : children}
				</div>
			)}
		</details>
	);
});
