/**
 * 置顶 / 取消置顶（新置顶排最前）：会话、项目、手动添加的项目表共用，store 与组件都走它，
 * 别各写一套。
 *
 * **为什么单独一个叶模块**：这条 3 行纯函数被 `stores/ui-preferences.ts`（置顶表就是它持久化的）
 * 与左栏派生层共用。原先它挂在 `lib/sidebar-groups.ts` 上，于是形成环
 * `stores/projects → stores/sessions → stores/ui-preferences → lib/sidebar-groups → stores/projects`：
 * 有环的模块图里「模块体在谁的 import 过程中执行」不确定，模块作用域的副作用
 * （如 `stores/projects.ts` 底部的目录写穿订阅）会随机读到尚未求值的 store 绑定。
 * 拆成叶模块后 renderer 的 import 图无环，模块体执行顺序不再影响正确性。
 */
export function toggleInList(list: readonly string[], id: string): string[] {
	return list.includes(id) ? list.filter((item) => item !== id) : [id, ...list];
}
