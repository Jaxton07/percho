import { type AnyChannelDef, type InvokeHandlers, isEnvironmentInvocation } from "@percho/shared";
import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { environmentRouter } from "../environment-router";

/**
 * 表驱动 invoke 注册：通道字符串来自子表（shared/ipc-channels.ts 单一事实源），
 * handler 体在域文件就近维护（satisfies/InvokeHandlers 构造点校验 args/ret 类型）。
 */
export function registerInvokeHandlers<T extends Record<string, AnyChannelDef>>(
	table: T,
	handlers: {
		[K in keyof T]: (
			args: Parameters<InvokeHandlers<T>[K]>[0],
			event?: IpcMainInvokeEvent,
		) => ReturnType<InvokeHandlers<T>[K]>;
	},
): void {
	for (const [key, def] of Object.entries(table) as [keyof T & string, AnyChannelDef][]) {
		const handler = handlers[key] as (args: unknown, event?: IpcMainInvokeEvent) => unknown;
		environmentRouter.registerLocal(def.channel, handler);
		ipcMain.handle(def.channel, (event, args: unknown) => {
			if (def.scope === "environment" || isEnvironmentInvocation(args))
				return environmentRouter.invoke(def.channel, args);
			return handler(args, event);
		});
	}
}
