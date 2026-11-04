import { type ChatRow, previewExcerpt, type SessionNavigationEntry } from "@percho/shared";

/** 一个导航节点：要么指向已加载的行（index），要么指向还没加载的历史 entry（entryId） */
export interface RailNode {
	key: string;
	excerpt: string;
	/** 本轮助手首段正文摘要；还没回复或只有工具时为空 */
	reply?: string;
	/** 已加载：在 rows 里的下标；未加载：-1 */
	index: number;
	entryId?: string;
}

export const RAIL_EXCERPT_CHARS = 120;

/**
 * 视觉参数（CSS px）。取自用户提供的 Codex 真实截图：截图像素量得
 * 间距 15、普通 9×3、梯度 15/21/30、当前 39×3，左端对齐。
 * 截图与 Percho 截图都来自同一台 150% 缩放（144 DPI）的机器，按 1.5 换算到 CSS px。
 * 只是视觉拟合，不是 Codex 官方规格；调整只改这里。
 */
export const RAIL_STYLE = {
	/** 节点间距 */
	gap: 10,
	/** 与当前（聚焦）节点的距离 → 宽度；超出序列取最后一项（普通节点） */
	widths: [26, 20, 14, 10, 6],
	/** 横线高度 */
	height: 2,
	/**
	 * 局部窗口最多同时显示的节点数（且不超过轨道可用高度）。Codex 截图里约 1000 CSS px 高的对话区只显示了 17 条、
	 * 集中在中部；无法确认那是上限还是该会话刚好 17 轮。这里取 25 作为可调起点，不是已核实的规则。
	 */
	maxVisible: 25,
} as const;
/** 节点固定间距（像素）；不随正文长度变化 */
export const NODE_GAP = RAIL_STYLE.gap;
/** 导航条上下内边距 */
export const RAIL_PAD = 12;

/** 聚焦梯度：节点宽度只由它与聚焦节点的序号距离决定；没有聚焦节点时全是普通宽度 */
export function tickWidth(
	ordinal: number,
	focus: number,
	widths: readonly number[] = RAIL_STYLE.widths,
): number {
	const last = widths[widths.length - 1] ?? 0;
	if (focus < 0) return last;
	return widths[Math.abs(ordinal - focus)] ?? last;
}

const excerptOf = (text: string) => previewExcerpt(text, RAIL_EXCERPT_CHARS);

/**
 * 全历史节点 = 服务端索引里「早于已加载首条 user entry」的部分 + 已加载行里的全部用户消息（含实时新消息）。
 * 已加载部分以行为准，所以增量追加、撤回、重载后不会与列表错位；服务端索引只补未加载的前缀。
 */
export function railNodes(
	rows: readonly ChatRow[],
	navigation: readonly SessionNavigationEntry[] | null,
): RailNode[] {
	const loaded: RailNode[] = [];
	let firstEntryId: string | undefined;
	rows.forEach((row, index) => {
		if (row.kind !== "message") return;
		const message = row.message;
		if (message.kind === "assistant") {
			// 本轮第一段有正文的助手消息作为预览摘要（后续段落/工具不再覆盖）
			const last = loaded.at(-1);
			if (last && last.reply === undefined && message.text.trim()) last.reply = excerptOf(message.text);
			return;
		}
		if (message.kind !== "user") return;
		const entryId = message.entryId;
		if (firstEntryId === undefined && entryId) firstEntryId = entryId;
		loaded.push({ key: row.key, excerpt: excerptOf(message.text), index, entryId });
	});
	if (!navigation?.length) return loaded;
	// 已加载首条在索引中的位置之前，才是未加载部分；找不到（索引过期或非持久消息）就不补，避免错位
	const cut =
		firstEntryId === undefined ? -1 : navigation.findIndex((entry) => entry.entryId === firstEntryId);
	if (cut <= 0) return loaded;
	const unloaded = navigation.slice(0, cut).map((entry) => ({
		key: `nav:${entry.entryId}`,
		excerpt: excerptOf(entry.excerpt),
		reply: entry.reply ? excerptOf(entry.reply) : undefined,
		index: -1,
		entryId: entry.entryId,
	}));
	return [...unloaded, ...loaded];
}

/**
 * 当前节点：视口顶端所在行之前最近的已加载用户消息；滚到底时取视口内最后一条。
 * nodes 里已加载部分按 index 升序，二分查找。
 */
export function activeNode(
	nodes: readonly RailNode[],
	firstRow: number,
	lastRow: number,
	atBottom: boolean,
): number {
	const limit = atBottom ? lastRow : firstRow;
	let lo = 0;
	let hi = nodes.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const index = nodes[mid]?.index ?? -1;
		if (index <= limit) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	// 视口在首条已加载用户消息之前（首屏是更早的助手回复）：落到第一个已加载节点
	if (found >= 0 && (nodes[found]?.index ?? -1) < 0) {
		const firstLoaded = nodes.findIndex((node) => node.index >= 0);
		return firstLoaded >= 0 ? firstLoaded : found;
	}
	return found;
}

/**
 * 局部导航窗口：可见节点数由可用高度与间距决定（不写死条数）。节点全部放得下时全部显示、顶部对齐，
 * 不拉伸；放不下时窗口跟随当前节点：优先把它放在窗口中部，到全历史首/尾时贴边（不留空白、不遗漏）。
 * 返回节点列相对导航条顶的偏移（≤0），与 nodeY / nodeAt / visibleNodeRange 配合使用。
 */
export function windowOffset(count: number, railHeight: number, anchor: number): number {
	const column = count > 0 ? (count - 1) * NODE_GAP + 2 * RAIL_PAD : 0;
	const overflow = column - railHeight;
	if (overflow <= 0 || railHeight <= 0) return 0;
	const target = anchor < 0 ? count - 1 : anchor;
	// 把锚点节点放在可用高度中部，再夹到 [-overflow, 0]：顶部/底部自然贴边
	const ideal = railHeight / 2 - nodeY(target);
	return Math.round(Math.min(0, Math.max(-overflow, ideal))) || 0;
}

export const nodeY = (ordinal: number) => RAIL_PAD + ordinal * NODE_GAP;

/** n 个节点排成一列的总高度（含上下内边距） */
export const columnHeight = (count: number) => (count > 0 ? (count - 1) * NODE_GAP + 2 * RAIL_PAD : 0);

/**
 * 可见导航区高度：不超过可用高度、不超过 maxVisible 个节点，也不超过节点实际排列高度。
 * 轨道把这个区域垂直居中，所以少量节点是中部的一小簇，而不是从顶部铺下来。
 */
export function viewHeight(
	count: number,
	available: number,
	maxVisible: number = RAIL_STYLE.maxVisible,
): number {
	return Math.max(0, Math.min(available, columnHeight(Math.min(count, maxVisible)), columnHeight(count)));
}

/** 导航条内 y（已含列偏移）→ 最近节点序号 */
export function nodeAt(y: number, offset: number, count: number): number {
	if (count <= 0) return -1;
	return Math.min(count - 1, Math.max(0, Math.round((y - offset - RAIL_PAD) / NODE_GAP)));
}

/** 只渲染导航条可见范围内的节点（上下各留一点余量），DOM 与历史长度无关 */
export function visibleNodeRange(
	count: number,
	railHeight: number,
	offset: number,
): { from: number; to: number } {
	if (count <= 0) return { from: 0, to: 0 };
	// 导航条还没测到高度（首帧）：按一个常见窗口高度估算，仍有上限，不会把全部节点都渲染出来
	if (railHeight <= 0) railHeight = 1200;
	const from = Math.max(0, Math.floor((-offset - RAIL_PAD) / NODE_GAP) - 2);
	const to = Math.min(count, Math.ceil((railHeight - offset - RAIL_PAD) / NODE_GAP) + 3);
	return { from, to: Math.max(from, to) };
}
