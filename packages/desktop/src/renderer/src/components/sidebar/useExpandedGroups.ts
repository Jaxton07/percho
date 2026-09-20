import { useCallback } from "react";
import { toggleExpandedGroup } from "../../lib/sidebar-groups";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

/**
 * 左侧栏展开态的读写（日常 / 各项目两处共用）。
 * 默认推断在纯函数层（`deriveSidebarGroups().defaultExpandedKeys`）：`expandedGroupsTouched === false`
 * （用户从没手动开合过）时首次开合以默认集为起点；之后完全以用户记录为准（空数组 = 全部折叠）。
 * 取值用 `getState()` 而不是闭包里的快照：同一 tick 内连点两个组时，闭包快照会让后一次覆盖前一次。
 */
export function useExpandedGroups() {
	const setExpandedGroups = useUiPreferencesStore((s) => s.setExpandedGroups);
	const toggleGroup = useCallback(
		(key: string, defaults: readonly string[]) => {
			const { expandedGroups, expandedGroupsTouched } = useUiPreferencesStore.getState();
			setExpandedGroups(toggleExpandedGroup(expandedGroups, key, defaults, expandedGroupsTouched));
		},
		[setExpandedGroups],
	);
	return { toggleGroup };
}
