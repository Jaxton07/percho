/** lan-web 内联 SVG 图标库（UX v2）：path 全部从设计稿 .local/design/ux/lan_observer/index.html
 *  `<symbol>` 块搬运。惯例同桌面端 renderer/src/components/icons/（函数组件 + currentColor），
 *  零依赖（不引图标库）。除 StopIcon 实心填充外均为 1.6–2.4px stroke round。 */

interface IconProps {
	size?: number;
	className?: string;
}

const strokeProps = {
	fill: "none",
	stroke: "currentColor",
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

/** 返回（聊天页 nav-back） */
export function ChevronLeftIcon({ size = 17, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={2}
			aria-hidden="true"
		>
			<path d="M15 18l-6-6 6-6" />
		</svg>
	);
}

/** 右向 chevron（列表卡 / 折叠组展开指示） */
export function ChevronRightIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={2}
			aria-hidden="true"
		>
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}

/** 发送（圆形黑白钮内白 ↑） */
export function ArrowUpIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={2.2}
			aria-hidden="true"
		>
			<path d="M12 19V5M5 12l7-7 7 7" />
		</svg>
	);
}

/** 停止（实心圆角方块） */
export function StopIcon({ size = 15, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<rect x="7" y="7" width="10" height="10" rx="2.5" />
		</svg>
	);
}

/** 盾牌（权限请求） */
export function ShieldIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={1.8}
			aria-hidden="true"
		>
			<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" />
			<path d="M9.5 12l2 2 3.5-4" />
		</svg>
	);
}

/** 图片占位 */
export function ImageIcon({ size = 20, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={1.6}
			aria-hidden="true"
		>
			<rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
			<circle cx="9" cy="10" r="1.6" />
			<path d="M4.5 17.5l4.8-4.2c.6-.5 1.4-.5 1.9.1l3.3 3.6 2.2-1.9c.6-.5 1.5-.5 2 .1l1.8 2" />
		</svg>
	);
}

/** 列表（Todo 条） */
export function ListIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={1.8}
			aria-hidden="true"
		>
			<path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
			<circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none" />
			<circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
			<circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none" />
		</svg>
	);
}

/** 完成勾（Todo 已完成项） */
export function CheckIcon({ size = 12, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={2.4}
			aria-hidden="true"
		>
			<path d="M5 13l4 4L19 7" />
		</svg>
	);
}

/** 空心圆（Todo 待办项） */
export function CircleIcon({ size = 12, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={2}
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="8" />
		</svg>
	);
}

/** 半满圆（Todo 进行中项） */
export function HalfIcon({ size = 12, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={2}
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="8" />
			<path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none" />
		</svg>
	);
}

/** 锁（令牌输入框） */
export function LockIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={1.8}
			aria-hidden="true"
		>
			<rect x="5" y="11" width="14" height="9.5" rx="2.8" />
			<path d="M8 11V8a4 4 0 018 0v3" />
		</svg>
	);
}

/** 叉（错误行） */
export function XIcon({ size = 12, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeWidth={2}
			aria-hidden="true"
		>
			<path d="M6 6l12 12M18 6L6 18" />
		</svg>
	);
}
