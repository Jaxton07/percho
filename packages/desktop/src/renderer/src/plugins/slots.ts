import type { SubagentRunUi, UIToolCall } from "@percho/shared";

/**
 * 槽位目录 v1：槽位名与 props 契约的单一来源（spec §4）。
 * 槽位名单与 shared 的 KNOWN_UI_SLOTS 对齐（main 进程校验 manifest.slots 用同一份），
 * 由 registry.test.ts 断言两者一致，避免两端漂移。
 */
export const UI_SLOTS = {
	ToolCallCard: "chat.tool-call-card",
	SubagentCard: "chat.subagent-card",
	TodoPanel: "chat.todo-panel",
} as const;
export type SlotName = (typeof UI_SLOTS)[keyof typeof UI_SLOTS];

/**
 * 区域目录 v1（spec §15）：往页面加挂新组件的挂载点。
 * 与 shared 的 KNOWN_UI_REGIONS 对齐（main 进程校验 manifest.contributions 用同一份），
 * 由 registry.test.ts 断言两者一致，避免两端漂移。
 */
export const UI_REGIONS = {
	AppBackground: "app.background",
	AppOverlay: "app.overlay",
	CornerTopLeft: "chat.corner.top-left",
	CornerTopRight: "chat.corner.top-right",
	CornerBottomLeft: "chat.corner.bottom-left",
	CornerBottomRight: "chat.corner.bottom-right",
	SettingsPanel: "settings.panel",
} as const;
export type RegionName = (typeof UI_REGIONS)[keyof typeof UI_REGIONS];

/** 每个槽位的 props 契约：插件组件与 fallback 组件都按此签名 */
export interface SlotPropsMap {
	[UI_SLOTS.ToolCallCard]: { tool: UIToolCall };
	[UI_SLOTS.SubagentCard]: { runs: SubagentRunUi[] };
	[UI_SLOTS.TodoPanel]: Record<string, never>;
}
