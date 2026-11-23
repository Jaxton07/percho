import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

// Normalized coordinates adapt to the SVG viewport without rewriting circles on every label change.
const GROUPS = Array.from({ length: 9 }, (_, id) => {
	let seed = 38197 + id * 917;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	const particles = Array.from({ length: 30 }, (_, key) => {
		const x = (id + random()) / 9;
		const y = 12 + (random() + random() - 1) * 8.7;
		const edge = Math.max(0.08, Math.min(1, x / 0.03, (1 - x) / 0.04));
		return {
			key,
			x: `${x * 100}%`,
			y,
			opacity: (0.35 + random() * 0.65) * edge,
			radius: 0.35 + random() ** 1.8 * 0.75,
		};
	});
	return { id, style: { animationDelay: `${-id * 0.2}s` }, particles };
});

/** One continuous decoration per running group; activity names and streamed text are not inputs. */
export const StatusParticles = memo(function StatusParticles() {
	const ref = useRef<SVGSVGElement>(null);
	const [count, setCount] = useState(0);
	const [paused, setPaused] = useState(() => document.hidden || !document.hasFocus());

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const resize = (width: number) => {
			setCount(width > 0 ? Math.ceil(Math.min(270, Math.max(48, Math.round(width / 3))) / 9) : 0);
		};
		resize(element.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) resize(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		// Electron keeps document visible when background throttling is disabled for task reminders.
		// Pause this decoration on blur as well; streamed activity remains independent of focus.
		const update = () => setPaused(document.hidden || !document.hasFocus());
		document.addEventListener("visibilitychange", update);
		window.addEventListener("blur", update);
		window.addEventListener("focus", update);
		update();
		return () => {
			document.removeEventListener("visibilitychange", update);
			window.removeEventListener("blur", update);
			window.removeEventListener("focus", update);
		};
	}, []);

	return (
		<svg
			ref={ref}
			aria-hidden="true"
			className="status-particles h-6 min-w-0 flex-1 overflow-hidden text-ink"
			fill="currentColor"
			data-paused={paused ? "" : undefined}
		>
			{GROUPS.map(({ id, style, particles }) => (
				<g key={id} className="status-particle-group" style={style}>
					{particles.slice(0, count).map(({ key, x, y, radius, opacity }) => (
						<circle key={key} cx={x} cy={y} r={radius} opacity={opacity} />
					))}
				</g>
			))}
		</svg>
	);
});
