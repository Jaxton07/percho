/** 自动更新状态（main → renderer，update:event 通道）。
    available 的 manual=true 表示当前构建无法自动安装（mac adhoc/未签名，Squirrel 签名校验不过），
    renderer 不应触发下载，点击改为跳 GitHub release 页手动下载 */
export type UpdateState =
	| { phase: "checking" }
	| { phase: "available"; version: string; manual: boolean }
	| { phase: "not-available" }
	| { phase: "downloading"; version: string; percent: number }
	| { phase: "downloaded"; version: string }
	| { phase: "error"; message: string };
