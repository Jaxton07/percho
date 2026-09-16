import type { AnyChannelDef, InvokeHandlers } from "@percho/shared";
import { ipcMain } from "electron";

/**
 * 表驱动 invoke 注册：通道字符串来自子表（shared/ipc-channels.ts 单一事实源），
 * handler 体在域文件就近维护（satisfies/InvokeHandlers 构造点校验 args/ret 类型）。
 */
export function registerInvokeHandlers<T extends Record<string, AnyChannelDef>>(
	table: T,
	handlers: InvokeHandlers<T>,
): void {
	for (const [key, def] of Object.entries(table) as [keyof T & string, AnyChannelDef][]) {
		const handler = handlers[key] as (args: unknown) => unknown;
		ipcMain.handle(def.channel, (_e, args) => handler(args));
	}
}
