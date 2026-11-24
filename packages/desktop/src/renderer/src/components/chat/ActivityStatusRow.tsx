import { useId, useLayoutEffect, useRef, useState } from "react";
import { useI18nStore, useT } from "../../i18n";
import { type ActivityStatus, STATUS, translateActivityStatus } from "./activity-status";
import {
	BAND,
	ENVELOPE,
	MAX_PARTICLES,
	MIN_SWEEP_DURATION,
	PARTICLE_SPACING,
	PARTICLES,
	SWEEP_SPEED,
} from "./activity-status-animation";
import "./activity-status.css";

interface ActivityStatusRowProps {
	status: ActivityStatus;
	thinkingId?: string;
	hasRunningTool?: boolean;
	scope?: string;
}

export function ActivityStatusRow({
	status,
	thinkingId,
	hasRunningTool = false,
	scope,
}: ActivityStatusRowProps) {
	const t = useT();
	const language = useI18nStore((s) => s.language);
	const [current, setCurrent] = useState(status);
	const [count, setCount] = useState(0);
	const [revision, setRevision] = useState(0);
	const [reduced, setReduced] = useState(
		() =>
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const [staticFallback, setStaticFallback] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const words = useRef<HTMLSpanElement>(null);
	const label = useRef<HTMLSpanElement>(null);
	const svg = useRef<SVGSVGElement>(null);
	const lens = useRef<SVGRectElement>(null);
	const highlight = useRef<SVGUseElement>(null);
	const currentRef = useRef(current);
	const latest = useRef(status);
	const inputs = useRef({ thinkingId, hasRunningTool });
	const thinkingVersion = useRef(0);
	const translator = useRef(t);
	const previousScope = useRef(scope);
	const enterNext = useRef(true);
	const generation = useRef(0);
	const id = useId().replace(/:/g, "");
	const shapeId = `activity-shape-${id}`;
	const gradientId = `activity-gradient-${id}`;
	const maskId = `activity-mask-${id}`;
	translator.current = t;
	currentRef.current = current;

	useLayoutEffect(() => {
		if (inputs.current.thinkingId !== thinkingId || inputs.current.hasRunningTool !== hasRunningTool)
			thinkingVersion.current++;
		inputs.current = { thinkingId, hasRunningTool };
		latest.current = status;
		// Static presentation has no pass boundary to promote independent thinking.
		const next = (reduced || staticFallback) && thinkingId && !hasRunningTool ? STATUS.thinking : status;
		if (previousScope.current !== scope) {
			previousScope.current = scope;
			enterNext.current = true;
			currentRef.current = next;
			setCurrent(next);
			setRevision((n) => n + 1);
		} else if (reduced || staticFallback) {
			currentRef.current = next;
			setCurrent(next);
		}
	}, [status, thinkingId, hasRunningTool, scope, reduced, staticFallback]);

	useLayoutEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduced(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	// Playback is deliberately rebuilt when the shown item, language or measured geometry changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: those values invalidate the route, not its callbacks.
	useLayoutEffect(() => {
		const container = root.current;
		const text = words.current;
		const textLabel = label.current;
		const field = svg.current;
		const mask = lens.current;
		const glow = highlight.current;
		if (!container || !text || !textLabel || !field || !mask || !glow) return;
		const epoch = ++generation.current;
		let animations: Animation[] = [];
		let particleAnimations: Animation[] = [];
		let controller: Animation | undefined;
		let alive = true;
		let lastSize = "";
		let resizeFrame = 0;
		const details: HTMLDetailsElement[] = [];
		for (let parent = container.parentElement; parent; parent = parent.parentElement) {
			if (parent instanceof HTMLDetailsElement) details.push(parent);
		}
		const expanded = () => details.some((detail) => detail.open);
		const paused = () => document.hidden;
		const syncPause = () => {
			if (paused()) field.setAttribute("data-paused", "");
			else field.removeAttribute("data-paused");
			field.style.visibility = expanded() ? "hidden" : "";
			if (!controller || controller.playState === "finished") return;
			if (paused())
				animations.forEach((a) => {
					a.pause();
				});
			else {
				const time = Number(controller.currentTime ?? 0);
				const start = Number(document.timeline.currentTime ?? 0) - time;
				for (const animation of animations) {
					if (expanded() && particleAnimations.includes(animation)) {
						animation.pause();
						animation.currentTime = time;
					} else {
						animation.play();
						// Assign after play: pending resume tasks must not choose different frames.
						animation.startTime = start;
					}
				}
			}
		};
		const observer = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(syncPause);
		details.forEach((detail) => {
			observer?.observe(detail, { attributes: true, attributeFilter: ["open"] });
		});
		document.addEventListener("visibilitychange", syncPause);
		const measure = () => {
			const textRect = text.getBoundingClientRect();
			const fieldRect = field.getBoundingClientRect();
			const size = `${textRect.width},${fieldRect.width},${fieldRect.left - textRect.right}`;
			setCount(
				fieldRect.width > 0
					? Math.ceil(
							Math.min(MAX_PARTICLES, Math.max(48, Math.round(fieldRect.width / PARTICLE_SPACING))) /
								PARTICLES.length,
						)
					: 0,
			);
			if (lastSize && size !== lastSize) {
				enterNext.current = false;
				setRevision((n) => n + 1);
			}
			lastSize = size;
		};
		measure();
		const resize =
			typeof ResizeObserver === "undefined"
				? undefined
				: new ResizeObserver(() => {
						cancelAnimationFrame(resizeFrame);
						resizeFrame = requestAnimationFrame(measure);
					});
		resize?.observe(text);
		resize?.observe(field);
		const clearSweep = () => {
			textLabel.classList.remove("activity-status-sweep");
			textLabel.style.backgroundImage = "";
			textLabel.style.backgroundSize = "";
			textLabel.style.backgroundRepeat = "";
			mask.style.transform = `translateX(-${BAND}px)`;
		};
		const stop = () => {
			animations.forEach((a) => {
				a.cancel();
			});
			animations = [];
			particleAnimations = [];
			controller = undefined;
			clearSweep();
		};
		const supported =
			typeof text.animate === "function" &&
			typeof textLabel.animate === "function" &&
			typeof mask.animate === "function" &&
			typeof glow.animate === "function";
		if (!supported && !staticFallback) setStaticFallback(true);
		const wait = async (animation: Animation) => {
			try {
				await animation.finished;
				return alive && generation.current === epoch;
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") return false;
				throw error;
			}
		};
		const run = async () => {
			if (enterNext.current) {
				enterNext.current = false;
				container.dataset.phase = "enter";
				controller = text.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }], {
					duration: Math.max(1, Math.round((text.getBoundingClientRect().width / SWEEP_SPEED) * 1000)),
					easing: "linear",
				});
				animations = [controller];
				syncPause();
				if (!(await wait(controller))) return;
				stop();
			}
			while (alive && generation.current === epoch) {
				const startThinking = !inputs.current.hasRunningTool ? inputs.current.thinkingId : undefined;
				const startThinkingVersion = thinkingVersion.current;
				const tr = text.getBoundingClientRect();
				const pr = field.getBoundingClientRect();
				const gap = Math.max(0, pr.left - tr.right);
				const width = tr.width + gap + pr.width;
				const duration = Math.max(MIN_SWEEP_DURATION, Math.round(((width + BAND) / SWEEP_SPEED) * 1000));
				const shine = ENVELOPE.map(
					({ offset, alpha }) =>
						`color-mix(in srgb, var(--color-ink) ${(alpha * 100).toFixed(3)}%, transparent) ${offset * 100}%`,
				).join(",");
				textLabel.style.backgroundImage = `linear-gradient(90deg, ${shine}), linear-gradient(currentColor, currentColor)`;
				textLabel.style.backgroundSize = `${BAND}px 100%, 100% 100%`;
				textLabel.style.backgroundRepeat = "no-repeat";
				textLabel.classList.add("activity-status-sweep");
				controller = textLabel.animate(
					[{ backgroundPosition: `-${BAND}px 0, 0 0` }, { backgroundPosition: `${width}px 0, 0 0` }],
					{ duration, easing: "linear" },
				);
				const sweep = mask.animate(
					[
						{ transform: `translateX(${-BAND - tr.width - gap}px)` },
						{ transform: `translateX(${pr.width}px)` },
					],
					{ duration, easing: "linear" },
				);
				const breathe = glow.animate(
					[{ transform: "scaleY(.88)" }, { transform: "scaleY(1.04)" }, { transform: "scaleY(.88)" }],
					{ duration, easing: "ease-in-out" },
				);
				// Cancellation rejects every track, not only the controller.
				void wait(sweep);
				void wait(breathe);
				particleAnimations = [sweep, breathe];
				animations = [controller, ...particleAnimations];
				const start = document.timeline.currentTime;
				animations.forEach((a) => {
					a.startTime = start;
				});
				container.dataset.phase = "pass";
				syncPause();
				if (!(await wait(controller))) return;
				stop();
				const input = inputs.current;
				const candidate =
					startThinking &&
					startThinking === input.thinkingId &&
					!input.hasRunningTool &&
					startThinkingVersion === thinkingVersion.current
						? STATUS.thinking
						: latest.current;
				if (
					translateActivityStatus(candidate, translator.current) !==
					translateActivityStatus(currentRef.current, translator.current)
				) {
					enterNext.current = true;
					currentRef.current = candidate;
					setCurrent(candidate);
					return;
				}
			}
		};
		if (supported && !reduced && !staticFallback) void run();
		else {
			container.dataset.phase = "static";
			syncPause();
		}
		return () => {
			alive = false;
			generation.current++;
			stop();
			field.style.visibility = "";
			observer?.disconnect();
			resize?.disconnect();
			cancelAnimationFrame(resizeFrame);
			document.removeEventListener("visibilitychange", syncPause);
		};
	}, [current, language, revision, reduced, staticFallback]);

	const text = translateActivityStatus(current, t);
	return (
		<span ref={root} className="activity-status" data-static={reduced || staticFallback ? "" : undefined}>
			<span ref={words} className="activity-status-words">
				<span
					ref={label}
					className={`activity-status-label font-bold text-ink-working ${current.kind === "legacy" ? "font-mono text-ui-13" : "text-ui-14"}`}
				>
					{text}
				</span>
			</span>
			<svg ref={svg} aria-hidden="true" className="status-particles text-ink" fill="currentColor">
				<defs>
					<g id={shapeId}>
						{PARTICLES.map((group) => (
							<g key={group[0]?.x}>
								{group.slice(0, count).map((p) => (
									<circle key={p.x} cx={p.x} cy={p.y} r={p.r} opacity={p.opacity} />
								))}
							</g>
						))}
					</g>
					<linearGradient id={gradientId}>
						{ENVELOPE.map(({ offset, alpha }) => (
							<stop key={offset} offset={offset} stopColor="white" stopOpacity={alpha} />
						))}
					</linearGradient>
					<mask
						id={maskId}
						maskUnits="userSpaceOnUse"
						maskContentUnits="userSpaceOnUse"
						x="0"
						y="0"
						width="100%"
						height="24"
						style={{ maskType: "alpha" }}
					>
						<rect
							ref={lens}
							x="0"
							y="0"
							width={BAND}
							height="24"
							fill={`url(#${gradientId})`}
							style={{ transform: `translateX(-${BAND}px)` }}
						/>
					</mask>
				</defs>
				<use href={`#${shapeId}`} className="activity-status-base" />
				<use
					ref={highlight}
					href={`#${shapeId}`}
					className="activity-status-highlight"
					mask={`url(#${maskId})`}
				/>
			</svg>
		</span>
	);
}
