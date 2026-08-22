/**
 * 更新决策纯函数：给定当前更新状态，判断用户点击更新入口后的下一步动作。
 * 独立模块不 import electron，可单测（updater.ts 的 main 进程逻辑薄委托到这里）。
 */

export interface UpdateActionState {
	/** 最近一次检查到的新版本（null = 尚未发现新版） */
	latestVersion: string | null;
	/** 已下载待安装 */
	downloaded: boolean;
	/** 当前构建无法自动安装（mac adhoc/未签名），装了也过不了签名校验 */
	manualInstall: boolean;
}

export type UpdateAction = "check" | "download" | "noop";

/**
 * 已发现新版、未下载、非 manual → 下载；已下载 → 无操作（等用户点重启）；
 * 其余（未发现新版 / manual 构建）→ 检查（manual 构建重复调用也只重查，由 renderer 层改跳 release 页）。
 */
export function nextUpdateAction(state: UpdateActionState): UpdateAction {
	if (state.latestVersion && !state.downloaded && !state.manualInstall) return "download";
	if (state.downloaded) return "noop";
	return "check";
}
