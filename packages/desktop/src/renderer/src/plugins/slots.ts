import { type SubagentRunUi, UI_SLOTS, type UIToolCall } from "@percho/shared";

// Keep the renderer import path compatible; identifier definitions live only in shared.
export { type RegionName, type SlotName, UI_REGIONS, UI_SLOTS } from "@percho/shared";

/** 每个槽位的 props 契约：插件组件与fallback组件都按此签名 */
export interface SlotPropsMap {
	[UI_SLOTS.ToolCallCard]: { tool: UIToolCall };
	[UI_SLOTS.SubagentCard]: { runs: SubagentRunUi[] };
	[UI_SLOTS.TodoPanel]: Record<string, never>;
}
