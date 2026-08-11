/** 自动更新状态（main → renderer，update:event 通道） */
export type UpdateState =
	| { phase: "checking" }
	| { phase: "available"; version: string }
	| { phase: "not-available" }
	| { phase: "downloading"; version: string; percent: number }
	| { phase: "downloaded"; version: string }
	| { phase: "error"; message: string };
