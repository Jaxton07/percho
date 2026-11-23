import type { ReactNode } from "react";

const glyphs = {
	close: <path d="m6 6 12 12M18 6 6 18" />,
	globe: (
		<>
			<circle cx="12" cy="12" r="9" />
			<ellipse cx="12" cy="12" rx="4" ry="9" />
			<path d="M3 12h18" />
		</>
	),
	server: (
		<>
			<rect x="3" y="3" width="18" height="7" rx="2" />
			<rect x="3" y="14" width="18" height="7" rx="2" />
			<path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
		</>
	),
	laptop: (
		<>
			<rect x="4" y="4" width="16" height="12" rx="2" />
			<path d="m4 16-2 4h20l-2-4M10 20h4" />
		</>
	),
	more: (
		<>
			<circle cx="5" cy="12" r=".8" />
			<circle cx="12" cy="12" r=".8" />
			<circle cx="19" cy="12" r=".8" />
		</>
	),
	folder: (
		<path d="M20 11V7a2 2 0 0 0-2-2h-6l-2-2H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6M2 9h18M17 14v8M13 18h8" />
	),
	refresh: <path d="M20 9a8 8 0 0 0-14-4L3 8m0-5v5h5M4 15a8 8 0 0 0 14 4l3-3m0 5v-5h-5" />,
	gear: (
		<>
			<path d="m10 3-.7 2.4-2 .9-2.3-.8-2 3.4 1.7 1.7v2.5L3 15l2 3.4 2.3-.7 2 .9L10 21h4l.7-2.4 2-.9 2.3.7 2-3.4-1.7-1.8v-2.5L21 9l-2-3.4-2.3.7-2-.9L14 3Z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	power: <path d="M12 2v9M6 5a9 9 0 1 0 12 0" />,
	exit: <path d="M10 4H5v16h5M10 12h12m-5-5 5 5-5 5" />,
	trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
		</>
	),
	archive: <path d="M4 8v13h16V8M3 3h18v5H3zM9 12h6" />,
	sliders: (
		<>
			<path d="M3 6h5m4 0h9M3 12h11m4 0h3M3 18h3m4 0h11" />
			<circle cx="10" cy="6" r="2" />
			<circle cx="16" cy="12" r="2" />
			<circle cx="8" cy="18" r="2" />
		</>
	),
	file: <path d="M13 3H5v18h14V9l-6-6v6h6M8 13h8M8 17h5" />,
	plug: <path d="M8 2v5m8-5v5M5 7h14v4a7 7 0 0 1-7 7v4M5 11h14" />,
	info: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v6m0-10v.1" />
		</>
	),
	devices: (
		<>
			<path d="M13 18H2V3h19v7M8 18v4m-4 0h8" />
			<rect x="16" y="12" width="6" height="10" rx="1" />
		</>
	),
	package: <path d="m12 2 10 5v10l-10 5L2 17V7l10-5Zm0 10 10-5M12 12 2 7m10 5v10M7 4.5l10 5V14" />,
} satisfies Record<string, ReactNode>;

export function SettingsIcon({
	name,
	size = 17,
	className,
}: {
	name: keyof typeof glyphs;
	size?: number;
	className?: string;
}) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.55}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{glyphs[name]}
		</svg>
	);
}
