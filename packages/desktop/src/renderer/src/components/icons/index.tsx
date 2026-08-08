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

/** 撤销/取回（回卷箭头，描边镂空） */
export function UndoIcon({ size = 14, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M9 14 4 9l5-5" />
			<path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
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

/** 展开箭头（来自 assets/icons/expand.svg）：默认朝右，展开时 rotate-90 朝下 */
export function ExpandArrowIcon({ size = 10, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 1024 1024"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M296.8 856l357.8-344-357.8-344c-7.9-7.5-12.4-18-12.5-28.9 0-36.5 45.9-54.8 72.7-28.9l357.8 344c33.3 32 33.3 83.9 0 115.8L357 913.9c-26.8 25.8-72.7 7.5-72.7-28.9 0-11 4.5-21.4 12.5-29z" />
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

/** 仪表盘（测试连接，外部下载 cesu.svg，1024 实心填充） */
export function TestIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 1024 1024"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M512 128c139.648 0 264.362667 63.893333 346.517333 164.053333l0.554667 0.618667 0.298667 0.384A446.144 446.144 0 0 1 960 576a446.72 446.72 0 0 1-131.2 316.8 32 32 0 0 1-45.290667-45.290667 383.722667 383.722667 0 0 0 96.213334-160.554666l-57.514667-13.269334a32 32 0 0 1 14.4-62.357333l56.362667 13.013333A388.053333 388.053333 0 0 0 896 576c0-80.725333-24.917333-155.626667-67.456-217.429333l-41.685333 33.749333a32 32 0 1 1-40.277334-49.749333l41.408-33.557334A382.869333 382.869333 0 0 0 544 193.322667v51.306666a32 32 0 0 1-64 0V193.322667a382.890667 382.890667 0 0 0-244.010667 115.690666l41.429334 33.578667a32 32 0 1 1-40.277334 49.706667l-41.685333-33.728A382.229333 382.229333 0 0 0 128 576c0 16.362667 1.024 32.512 3.029333 48.341333l56.362667-13.013333a32 32 0 0 1 14.4 62.357333l-57.514667 13.269334a383.722667 383.722667 0 0 0 96.213334 160.554666A32.021333 32.021333 0 0 1 195.2 892.8 446.72 446.72 0 0 1 64 576c0-107.242667 37.674667-205.653333 100.522667-282.794667l0.426666-0.533333 0.64-0.768C247.744 191.829333 372.416 128 512 128z m162.773333 309.162667c5.546667-3.584 11.669333 3.2 7.893334 8.746666L534.378667 664.96l-15.744 22.528c-15.018667 14.826667-70.506667 13.674667-90.048-18.922667-17.450667-29.098667-6.890667-60.757333 3.157333-72.128l7.765333-6.528 235.285334-152.725333z" />
		</svg>
	);
}

/** 编辑框（配置/更新 Key，外部下载 edit.svg，1024 实心填充） */
export function EditIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 1024 1024"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M772.181333 141.482667a37.12 37.12 0 0 0-5.290666 0.341333c-13.909333 0-26.069333 6.954667-34.730667 17.408l-219.306667 260.906667a164.821333 164.821333 0 0 0-26.026666 45.226666l-41.813334 142.677334a29.738667 29.738667 0 0 0 8.746667 34.773333 33.237333 33.237333 0 0 0 20.864 6.954667c5.205333 0 10.453333-1.706667 13.994667-5.205334l135.594666-64.384h1.706667c15.701333-8.661333 29.696-19.114667 40.106667-33.024l217.386666-257.450666c19.2-20.906667 15.744-53.973333-5.205333-71.338667L803.413333 154.026667c-9.045333-7.552-19.498667-12.501333-31.232-12.501334m-0.298666 69.845334l54.485333 46.805333-209.28 247.722667-1.194667 1.408-1.066666 1.493333a52.224 52.224 0 0 1-12.416 10.965333l-5.546667 2.645334-69.717333 33.066666 20.138666-68.906666c4.394667-10.368 9.386667-19.114667 14.592-25.173334l210.005334-250.026666" />
			<path d="M442.624 174.634667a32 32 0 0 1 4.309333 63.701333l-4.309333 0.298667H296.192a136.149333 136.149333 0 0 0-135.978667 128.426666l-0.213333 7.68v339.626667a136.106667 136.106667 0 0 0 128.426667 135.936l7.765333 0.213333H635.733333a136.106667 136.106667 0 0 0 135.850667-128.426666l0.213333-7.722667v-95.573333a32 32 0 0 1 63.701334-4.309334l0.298666 4.352v95.530667a200.106667 200.106667 0 0 1-190.933333 199.936l-9.130667 0.213333H296.106667a200.106667 200.106667 0 0 1-199.936-190.976l-0.213334-9.173333v-339.626667a200.149333 200.149333 0 0 1 191.018667-199.893333l9.173333-0.213333h146.432zM678.954667 224.085333a32 32 0 0 1 41.088-7.381333l3.882666 2.688 100.053334 81.152a32 32 0 0 1-36.394667 52.394667l-3.882667-2.688-100.053333-81.152a32 32 0 0 1-4.693333-45.013334z" />
		</svg>
	);
}

/** 垃圾桶（删除/移除凭证） */
export function TrashIcon({ size = 13, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			{...strokeProps}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M3 6h18" />
			<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
			<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
			<path d="M10 11v6M14 11v6" />
		</svg>
	);
}
