import { type ChatRow, previewExcerpt, type SessionNavigationEntry } from "@percho/shared";

/**
 * 对话 Minimap 的数据与几何（#110）。
 *
 * 机制参考 MIT 开源项目 pi-gna 的 TurnRail（manuelcecchetto/pi-gna，src/renderer/src/lib/rail.ts 与
 * components/TurnRail.tsx；其作者说明参考过 Codex 客户端的 thread-user-message-navigation-rail 模块）：
 * 每条用户消息一行刻度、行高固定、列表内部滚动、悬停放大相邻三格、在视口内的轮次提亮。
 * 这里只取机制，代码按 Percho 的数据模型重写。
 */

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
/** 少于这么多条用户消息时不显示（pi-gna: RAIL_MIN_ITEMS = 4） */
export const RAIL_MIN_NODES = 4;
/** 悬停放大影响的最远距离（pi-gna: nearDistance，0–3） */
export const NEAR_RANGE = 3;

// 已提交消息不可变，按对象而非 entryId 缓存：重装/分支换代可复用 ID，但正文可能不同。
// WeakMap 不延长历史消息的生命周期；流式行每次创建新对象，自然重新计算。
const excerpts = new WeakMap<object, { excerpt: string; hasText: boolean }>();
const excerptOf = (message: { text: string }) => {
	let cached = excerpts.get(message);
	if (!cached) {
		cached = { excerpt: previewExcerpt(message.text, RAIL_EXCERPT_CHARS), hasText: !!message.text.trim() };
		excerpts.set(message, cached);
	}
	return cached;
};

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
			if (last && last.reply === undefined) {
				const preview = excerptOf(message);
				if (preview.hasText) last.reply = preview.excerpt;
			}
			return;
		}
		if (message.kind !== "user") return;
		const entryId = message.entryId;
		if (firstEntryId === undefined && entryId) firstEntryId = entryId;
		loaded.push({ key: row.key, excerpt: excerptOf(message).excerpt, index, entryId });
	});
	if (!navigation?.length) return loaded;
	// 已加载首条在索引中的位置之前，才是未加载部分；找不到（索引过期或非持久消息）就不补，避免错位
	const cut =
		firstEntryId === undefined ? -1 : navigation.findIndex((entry) => entry.entryId === firstEntryId);
	if (cut <= 0) return loaded;
	const unloaded = navigation.slice(0, cut).map((entry) => ({
		key: `nav:${entry.entryId}`,
		excerpt: entry.excerpt,
		reply: entry.reply || undefined,
		index: -1,
		entryId: entry.entryId,
	}));
	return [...unloaded, ...loaded];
}

/**
 * 比较刻度实际渲染的内容：流式回复变化不重绘，重装后的标题和加载状态仍须更新。
 */
export function sameMarkers(a: readonly RailNode[], b: readonly RailNode[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const left = a[i];
		const right = b[i];
		if (
			!left ||
			!right ||
			left.key !== right.key ||
			left.excerpt !== right.excerpt ||
			left.index < 0 !== right.index < 0
		)
			return false;
	}
	return true;
}

/**
 * 视口内的轮次：一轮 = 一条用户消息到下一条用户消息之前的所有行。
 * 给出视口内首/末行下标（来自虚拟列表的位置索引），返回与这段行区间相交的节点序号区间 [from, to]；
 * 没有已加载节点时为 null。nodes 里已加载部分按 index 升序，二分查找。
 */
export function turnsInView(
	nodes: readonly RailNode[],
	firstRow: number,
	lastRow: number,
): { from: number; to: number } | null {
	// 最后一个 index <= row 的已加载节点
	const owner = (row: number) => {
		let lo = 0;
		let hi = nodes.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if ((nodes[mid]?.index ?? -1) <= row) {
				found = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return found;
	};
	const firstLoaded = nodes.findIndex((node) => node.index >= 0);
	if (firstLoaded < 0) return null;
	// 视口在首条已加载用户消息之前（首屏是更早的助手回复）：归到第一个已加载节点
	const from = Math.max(firstLoaded, owner(firstRow));
	const to = Math.max(from, owner(lastRow));
	return { from, to };
}

/** 与悬停节点的距离（0–3），超出返回 undefined（pi-gna: nearDistance） */
export function nearDistance(ordinal: number, hot: number | null): number | undefined {
	if (hot === null) return undefined;
	const distance = Math.abs(ordinal - hot);
	return distance <= NEAR_RANGE ? distance : undefined;
}
