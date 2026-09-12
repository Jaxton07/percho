/**
 * 消息流挂载窗口（长会话切换性能的单一事实源）。
 *
 * 问题：切会话时 MessageList 会把新会话的全部消息行一次性挂载（每个工具卡、每个 markdown
 * 代码块都在这次提交里创建 DOM / 初始化 monaco），成本随会话长度线性增长——两三千条消息的
 * 会话切一次要冻结主线程 1s 量级（实测 1278 行 ≈ 900ms 长任务）。
 *
 * 做法：只挂「尾部窗口」，更早的行在用户上滑接近顶部时成块补挂（只增不减）。
 * - 切换瞬间的挂载量恒定 → 切换耗时与会话长度解耦（实测 40 行窗口把该场景压到 ~190ms）；
 * - 窗口只增不减：不做反向回收，避免卸载顶部内容导致的滚动跳变与「滚回去还要重挂」；
 * - 流式追加只会在尾部新增行，窗口起点不动 → 长会话流式期间 DOM 规模也保持在窗口量级。
 *
 * 这里是纯函数部分（行数 → 窗口起点），滚动补偿与触发在 MessageList 内。
 */

/** 进入/切到会话时挂载的行数（尾部窗口，约两屏；改变它等于改变切换瞬间的挂载成本） */
export const INITIAL_MOUNTED_ROWS = 40;

/** 每次向上补挂的行数（一次提交的挂载量，过大就会轮到「补挂这一下」卡顿） */
export const MOUNT_CHUNK_ROWS = 30;

/** 距滚动容器顶部多少像素开始向上补挂（提前挂好，用户不会撞到「上面还有内容但没挂载」的空窗） */
export const MOUNT_TRIGGER_PX = 1000;

/** 尾部窗口起点：总行数 ≤ 窗口时返回 0（全部挂载，短会话与改动前完全一致） */
export function tailWindowStart(totalRows: number): number {
	if (!Number.isFinite(totalRows)) return 0;
	return Math.max(0, Math.floor(totalRows) - INITIAL_MOUNTED_ROWS);
}

/** 窗口起点夹紧：行数变少（撤回/重建历史）到窗口以下时回退为尾部窗口，避免空列表 */
export function clampWindowStart(start: number, totalRows: number): number {
	if (!Number.isFinite(start) || start <= 0) return 0;
	if (start >= totalRows) return tailWindowStart(totalRows);
	return Math.floor(start);
}

/** 向上补挂一块（夹到 0；到顶后返回 0，调用方可据此停止） */
export function expandWindowStart(start: number, totalRows: number): number {
	if (!Number.isFinite(start) || start <= 0) return 0;
	return clampWindowStart(Math.max(0, Math.floor(start) - MOUNT_CHUNK_ROWS), totalRows);
}
