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

/** todo 待办：细线空心圆环（描边风，淡雅灰系由使用方 text-* 控制） */
export function TodoPendingIcon({ size = 14, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	);
}

/** todo 已完成：对勾描边绘制动画（todo-check-path 类见 globals.css，仅新挂载行触发） */
export function TodoCompleteIcon({ size = 14, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				className="todo-check-path"
				d="M3.5 8.5l3 3 6-7"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** todo 进行中：弧线转圈（animate-spin 由使用方控制，颜色淡雅灰系） */
export function TodoSpinnerIcon({ size = 14, className }: IconProps) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle
				cx="8"
				cy="8"
				r="6"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeDasharray="26 12"
				strokeLinecap="round"
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

/** 刷新（循环箭头，设置页联网刷新模型目录） */
export function RefreshIcon({ size = 13, className }: IconProps) {
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
			<path d="M21 12a9 9 0 1 1-2.64-6.36" />
			<path d="M21 3v6h-6" />
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

/** 文件夹（打开目录） */
export function FolderIcon({ size = 13, className }: IconProps) {
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
			<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z" />
		</svg>
	);
}

/** 下载（顶栏更新按钮 / 更新进度环内图标） */
export function DownloadIcon({ size = 14, className }: IconProps) {
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
			<path d="M12 3v12" />
			<path d="m7 10 5 5 5-5" />
			<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
		</svg>
	);
}

/** 分叉（assistant 消息操作行，外部下载 fork.svg，1024 实心填充；path 与 .local/design/icons/fork.svg 原件逐字符一致，strokeWidth 20 为加粗调整） */
export function ForkIcon({ size = 16, className }: IconProps) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 1024 1024"
			fill="currentColor"
			aria-hidden="true"
		>
			<path
				stroke="currentColor"
				strokeWidth={20}
				strokeLinejoin="round"
				d="M759.53332137 326.35000897c0-48.26899766-39.4506231-87.33284994-87.87432908-86.6366625-46.95397689 0.69618746-85.08957923 39.14120645-85.39899588 86.09518335-0.23206249 40.68828971 27.53808201 74.87882971 65.13220519 84.47074592 10.82958281 2.78474987 18.41029078 12.37666607 18.64235327 23.51566553 0.38677082 21.11768647-3.40358317 44.40128953-17.24997834 63.81718442-22.20064476 31.17372767-62.42480948 42.46743545-97.93037026 52.44612248-22.43270724 6.26568719-38.75443563 7.89012462-53.14230994 9.28249954-20.42149901 2.01120825-39.76003975 3.94506233-63.89453858 17.79145747-5.10537475 2.93945818-10.13339535 6.18833303-14.85199928 9.74662453-4.09977063 3.09416652-9.90133285 0.15470833-9.90133286-4.95066641V302.60228095c0-9.43720788 5.26008307-18.17822829 13.69168683-22.3553531 28.69839444-14.23316598 48.42370599-43.93716454 48.19164353-78.20505872-0.38677082-48.57841433-41.15241468-87.71962076-89.730829-86.01782918C338.80402918 117.57112321 301.59667683 155.70672553 301.59667683 202.58334827c0 34.03583169 19.64795738 63.50776777 48.1916435 77.66357958 8.43160375 4.17712479 13.69168685 12.76343689 13.69168684 22.12329062v419.02750058c0 9.43720788-5.26008307 18.17822829-13.69168684 22.3553531-28.69839444 14.23316598-48.42370599 43.93716454-48.1916435 78.20505872 0.30941665 48.57841433 41.07506052 87.6422666 89.65347484 86.01782918C437.74000359 906.42887679 474.87000179 868.2159203 474.87000179 821.41665173c0-34.03583169-19.64795738-63.50776777-48.1916435-77.66357958-8.43160375-4.17712479-13.69168685-12.76343689-13.69168684-22.12329062v-14.85199926c0-32.48874844 15.39347842-63.27570528 42.00331048-81.91805854 2.39797906-1.70179159 4.95066642-3.32622901 7.50335379-4.79595812 14.92935344-8.58631209 25.91364457-9.66927037 44.09187287-11.4484161 15.62554091-1.54708326 35.04143581-3.48093734 61.65126786-10.90693699 39.06385228-10.98429114 92.51557887-25.91364457 124.84961898-71.39789238 18.56499911-26.06835292 27.38337367-58.01562219 26.37776956-95.14562041-0.15470833-5.33743724-0.54147915-10.67487447-1.08295828-16.16702004-0.85089578-8.27689543 2.70739569-16.24437421 9.12779121-21.50445729 19.57060322-15.78024923 32.02462345-39.99210223 32.02462345-67.14341343zM351.1033411 202.58334827c0-20.49885317 16.63114503-37.12999821 37.1299982-37.1299982s37.12999821 16.63114503 37.12999821 37.1299982-16.63114503 37.12999821-37.12999821 37.1299982-37.12999821-16.63114503-37.1299982-37.1299982z m74.25999641 618.83330346c0 20.49885317-16.63114503 37.12999821-37.12999821 37.1299982s-37.12999821-16.63114503-37.1299982-37.1299982 16.63114503-37.12999821 37.1299982-37.1299982 37.12999821 16.63114503 37.12999821 37.1299982z m247.53332139-457.93664456c-20.49885317 0-37.12999821-16.63114503-37.1299982-37.1299982s16.63114503-37.12999821 37.1299982-37.12999821 37.12999821 16.63114503 37.1299982 37.12999821-16.63114503 37.12999821-37.1299982 37.1299982z"
			/>
		</svg>
	);
}
