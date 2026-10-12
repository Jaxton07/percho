/**
 * 槽位锚点的**纯逻辑**（spec D2）：把「观察集合」与「测量占位集合」分开，并递归 `display: contents` 包层。
 *
 * 为什么要分开（review R11 的反例）：
 * - 观察集合必须包含**当前 0 高**的渲染根：插件可能先渲染一个空壳（高度 0），随后内容长出来。
 *   若按「height > 0」筛选后再 observe，那个根永远不被观察 ⇒ 它长大后布局不跟（表现为胶囊一直停在上一个位置）。
 * - 测量集合才该只算「真占位」的盒子（高度 > 0）：`display: contents` 元素自己没有盒子
 *   （rect 全 0，ResizeObserver 也不会为它回调），必须递归到它的子元素去找真正的盒子。
 *
 * 这里用注入的 adapter 表达「树」与「盒」，DOM 版在 `use-todo-anchor.ts` 里，单测用假树直接覆盖边界情形。
 */
export interface AnchorBox {
	width: number;
	height: number;
	bottom: number;
}

export interface AnchorTreeAdapter<T> {
	/** 元素子节点（不含文本节点） */
	elementChildren: (node: T) => T[];
	/** 是否是 `display: contents`（没有自己的盒子） */
	isDisplayContents: (node: T) => boolean;
	/** 读盒子（viewpor 坐标） */
	box: (node: T) => AnchorBox;
}

/** 宿主的直接元素子节点（渲染根） */
export function slotRoots<T>(host: T, adapter: AnchorTreeAdapter<T>): T[] {
	return adapter.elementChildren(host);
}

/**
 * **观察集合**：所有「可能变成盒子」的元素 —— 渲染根 + 递归穿过 `display: contents` 包层后的后代，
 * **不做高度筛选**（review R11 反例第二轮：包层里当前 0 高的子节点也必须被观察，否则它长大后布局不跟）。
 * `display: contents` 的元素自己没有盒、ResizeObserver 也不会为它回调，所以只能观察它里面的盒子。
 */
export function potentialBoxes<T>(host: T, adapter: AnchorTreeAdapter<T>): T[] {
	const out: T[] = [];
	const walk = (node: T) => {
		if (adapter.isDisplayContents(node)) {
			for (const child of adapter.elementChildren(node)) walk(child);
			return;
		}
		out.push(node);
	};
	for (const root of slotRoots(host, adapter)) walk(root);
	return out;
}

/**
 * **测量集合**（占位盒）：在观察集合的基础上只留「高度 > 0」的盒子。
 * 多根 / 包层 / 混合都支持。
 */
export function occupyingBoxes<T>(host: T, adapter: AnchorTreeAdapter<T>): T[] {
	return potentialBoxes(host, adapter).filter((node) => adapter.box(node).height > 0);
}

/** 锚点底边 = 所有占位盒 bottom 的最大值；没有任何占位盒 ⇒ null（调用方回到基准位置） */
export function anchorBottom<T>(host: T, adapter: AnchorTreeAdapter<T>): number | null {
	const boxes = occupyingBoxes(host, adapter);
	if (boxes.length === 0) return null;
	return Math.max(...boxes.map((box) => adapter.box(box).bottom));
}
