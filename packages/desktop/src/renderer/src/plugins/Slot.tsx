import type { ComponentType } from "react";
import { useUiPluginsStore } from "../stores/ui-plugins";
import { PluginBoundary } from "./PluginBoundary";
import { useUiPluginRegistry } from "./registry";
import type { SlotName, SlotPropsMap } from "./slots";

/**
 * 命名槽位挂载点：全局总开关开启且有激活 override 时渲染插件组件（外包错误边界），否则渲染 fallback。
 * 边界 key 带 loadNonce：热重载（remove+apply 被 React 批处理，边界实例不卸载重建）时
 * 换新边界实例，errored 状态自然归零（review 修项 B）。
 */
export function Slot<N extends SlotName>({
	name,
	props,
	fallback: Fallback,
}: {
	name: N;
	props: SlotPropsMap[N];
	fallback: ComponentType<SlotPropsMap[N]>;
}) {
	// overrides[name] 本身是稳定引用（map 项不重建），selector 直接取，勿 ?? 默认值造新引用
	const override = useUiPluginRegistry((s) => s.overrides[name]);
	const nonce = useUiPluginRegistry((s) => (override ? s.loadNonces[override.pluginName] : 0));
	// 全局总开关：关 = 全部插件立即停用（无需逐插件操作）
	const masterOn = useUiPluginsStore((s) => s.config.enabled);
	if (masterOn && override) {
		const PluginComponent = override.component as ComponentType<SlotPropsMap[N]>;
		return (
			<PluginBoundary
				key={`${override.pluginName}:${nonce}`}
				pluginName={override.pluginName}
				label={name}
				fallback={<Fallback {...props} />}
			>
				<PluginComponent {...props} />
			</PluginBoundary>
		);
	}
	return <Fallback {...props} />;
}
