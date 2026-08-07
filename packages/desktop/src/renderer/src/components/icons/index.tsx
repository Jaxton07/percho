/** 集中管理内联 SVG 图标：微调样式/尺寸只改这一处 */

interface IconProps {
	size?: number;
	className?: string;
}

const strokeProps = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
} as const;

/** 项目网格（顶栏切换项目管理页） */
export function GridIcon({ size = 15, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			aria-hidden="true"
		>
			<rect x="3" y="3" width="7" height="7" rx="1.5" />
			<rect x="14" y="3" width="7" height="7" rx="1.5" />
			<rect x="3" y="14" width="7" height="7" rx="1.5" />
			<rect x="14" y="14" width="7" height="7" rx="1.5" />
		</svg>
	);
}

/** 关闭/删除（×） */
export function CloseIcon({ size = 10, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden="true">
			<path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	);
}

/** codex 风格「新会话」编辑图标 */
export function ComposeIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			aria-hidden="true"
		>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
		</svg>
	);
}

/** 加号 */
export function PlusIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={1.5}
			aria-hidden="true"
		>
			<path d="M12 5v14M5 12h14" strokeLinecap="round" />
		</svg>
	);
}

/** 齿轮（设置） */
export function GearIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			aria-hidden="true"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
		</svg>
	);
}

/** 帮助（问号圆圈） */
export function HelpIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="10" />
			<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
			<path d="M12 17h.01" />
		</svg>
	);
}

/** 搜索放大镜 */
export function SearchIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			aria-hidden="true"
		>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" strokeLinecap="round" />
		</svg>
	);
}

/** 发送（纸飞机） */
export function SendIcon({ size = 12, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
			<path d="M2 1.5l8 4.5-8 4.5v-3.6l5-0.9-5-0.9z" fill="currentColor" />
		</svg>
	);
}

/** 发送（向上箭头，来自 assets/icons/up_arrow.svg） */
export function ArrowUpIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 1024 1024"
			fill="none"
			stroke="currentColor"
			strokeWidth={110}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M535 215V810" />
			<path d="M290 445L535 215l245 230" />
		</svg>
	);
}

/** 停止（方块） */
export function StopIcon({ size = 10, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 10 10"
			fill="currentColor"
			aria-hidden="true"
		>
			<rect x="0" y="0" width="10" height="10" rx="1.5" />
		</svg>
	);
}

/** 下拉箭头 */
export function ChevronDownIcon({ size = 10, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="m6 9 6 6 6-6"
				stroke="currentColor"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** 勾选 */
export function CheckIcon({ size = 12, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M20 6 9 17l-5-5"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
