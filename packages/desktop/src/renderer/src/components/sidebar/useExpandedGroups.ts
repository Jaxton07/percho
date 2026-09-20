import { useCallback } from "react";
import { toggleExpandedGroup } from "../../lib/sidebar-groups";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

/**
 * 左侧栏展开态的读写（日常 / 各项目 / 「项目」小标 三处共用）。
 * 默认推断在纯函数层（`deriveSidebarGroups().defaultExpandedKeys`）：`expandedGroups` 为空 = 用户还没手动开合过，
 * 首次开合以默认集为起点（`toggleExpandedGroup`），之后完全以用户记录为准；每次变更都落盘，重启保持。
 * 取值用 `getState()` 而不是闭包里的快照：同一 tick 内连点两个组时，闭包快照会让后一次覆盖前一次。
 */
export function useExpandedGroups() {
	const setExpandedGroups = useUiPreferencesStore((s) => s.setExpandedGroups);
	const toggleGroup = useCallback(
		(key: string, defaults: readonly string[]) => {
			const current = useUiPreferencesStore.getState().expandedGroups;
			setExpandedGroups(toggleExpandedGroup(current, key, defaults));
		},
		[setExpandedGroups],
	);
	return { toggleGroup };
}
