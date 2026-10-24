import type { UiPluginSettingValue } from "@percho/shared";
import { useCallback, useEffect, useMemo } from "react";
import { EMPTY_SETTINGS, usePluginSettingsStore } from "../stores/plugin-settings";

/**
 * 插件自有配置的读写入口（`@percho/plugin-api` 的 `hooks.usePluginSettings`）。
 *
 * ```tsx
 * const { values, update } = usePluginSettings("my-plugin", { browser: "chrome" });
 * <Switch checked={values.autoLaunch} onCheckedChange={(v) => update({ autoLaunch: v })} />
 * ```
 *
 * - 值只可能是 JSON 标量（string / number / boolean / null），main 侧有界校验后落 ui-plugins.json；
 * - 第一次挂载时读一次，之后走缓存；配置事件到达（别的窗口改了）由 loader 侧 invalidate；
 * - `defaults` 只在缺少键时生效，不写盘（插件升级改默认值不需要迁移）。
 */
export function usePluginSettings<T extends Record<string, UiPluginSettingValue>>(
	name: string,
	defaults?: Partial<T>,
): { values: T; update: (patch: Record<string, UiPluginSettingValue | undefined>) => void } {
	const stored = usePluginSettingsStore((s) => s.values[name]);
	// 作废会让缓存被删掉：挂载中的组件要跟着重读，否则会一直停在默认值上
	const revision = usePluginSettingsStore((s) => s.revisions[name] ?? 0);
	const load = usePluginSettingsStore((s) => s.load);
	const setValues = usePluginSettingsStore((s) => s.update);

	useEffect(() => {
		// revision 只用来触发重读（缓存被作废时自增），本身不参与逻辑
		void revision;
		void load(name);
	}, [load, name, revision]);

	const update = useCallback(
		(patch: Record<string, UiPluginSettingValue | undefined>) => {
			void setValues(name, patch);
		},
		[name, setValues],
	);

	// defaults 与 stored 合并：只在两者换了引用时才换新对象（`defaults` 请写在组件外或 useMemo 里，
	// 内联字面量会让这个 memo 每次都失效——用在 useEffect 依赖里就会无限重跑）
	const values = useMemo(
		() => ({ ...(defaults ?? {}), ...(stored ?? EMPTY_SETTINGS) }) as T,
		[defaults, stored],
	);
	return { values, update };
}
