import type {
	ExtensionDialogRequest,
	ExtensionDialogResolved,
	ExtensionEditorTextEvent,
	ExtensionNotifyEvent,
} from "./extension-dialog";
import type { CHANNEL_TABLE, InvokeApi } from "./ipc-channels";
import type { PermissionRequest, PermissionResolved, SessionEventEnvelope, TrustRequest } from "./session";
import type { LoginEventPayload } from "./settings";
import type { UiPluginsEventPayload } from "./ui-plugins";
import type { UpdateState } from "./update";

export {
	type AnyChannelDef,
	APP_CHANNELS,
	CHANNEL_TABLE,
	type ChannelCtor,
	type ChannelDef,
	ch,
	EXTENSION_DIALOG_CHANNELS,
	type InvokeApi,
	type InvokeHandlers,
	IpcChannels,
	LAN_CHANNELS,
	PACKAGES_CHANNELS,
	SESSION_CHANNELS,
	SETTINGS_CHANNELS,
	UI_PLUGINS_CHANNELS,
} from "./ipc-channels";

/**
 * 渲染进程经 preload 暴露的 window.pi 类型。
 * invoke 成员：表化通道由 InvokeApi<CHANNEL_TABLE> 推导（shared/ipc-channels.ts 单一事实源，
 * key = 方法名）；表外成员（订阅 on*、platform、getPathForFile）在下方手写。
 */
export interface PiApi extends InvokeApi<typeof CHANNEL_TABLE> {
	/** 运行平台（preload 同步注入，供 renderer 按平台分流 UI：如顶栏红绿灯/窗口按钮留白） */
	readonly platform: "darwin" | "win32" | "linux" | (string & {});
	/** Electron 沙箱渲染器中的 File 不再带 path；由 preload 同步解析原生拖入文件路径。 */
	getPathForFile(file: unknown): string;
	/** 订阅登录流程事件（event/prompt/prompt-cancel，按 loginId 归属）；返回取消函数 */
	onProviderLoginEvent(cb: (payload: LoginEventPayload) => void): () => void;
	/** 订阅更新状态（checking/available/downloading/downloaded/error）；返回取消函数 */
	onUpdateEvent(cb: (state: UpdateState) => void): () => void;
	/** 订阅 UI 插件事件（changed/config）；返回取消函数 */
	onUiPluginsEvent(cb: (payload: UiPluginsEventPayload) => void): () => void;
	/** 订阅「用户点了关闭窗口」（Windows 点 ✕，main 已拦下，等弹退出确认）；返回取消函数 */
	onQuitRequested(cb: () => void): () => void;
	/** 订阅会话事件；返回取消函数 */
	onEvent(cb: (payload: SessionEventEnvelope) => void): () => void;
	onPermissionRequest(cb: (req: PermissionRequest) => void): () => void;
	onPermissionResolved(cb: (result: PermissionResolved) => void): () => void;
	/** 订阅项目信任请求；返回取消函数 */
	onTrustRequest(cb: (req: TrustRequest) => void): () => void;
	/** 订阅扩展对话框请求（renderer 停靠槽数据源）；返回取消函数 */
	onExtensionDialogRequest(cb: (req: ExtensionDialogRequest) => void): () => void;
	/** 订阅扩展对话框结算（应答/超时/中止/会话关闭都会广播，撤卡）；返回取消函数 */
	onExtensionDialogResolved(cb: (result: ExtensionDialogResolved) => void): () => void;
	/** 订阅扩展 notify（→ 全局 Toast）；返回取消函数 */
	onExtensionNotify(cb: (event: ExtensionNotifyEvent) => void): () => void;
	/** 订阅扩展草稿预填（setEditorText/pasteToEditor → Composer）；返回取消函数 */
	onExtensionEditorText(cb: (event: ExtensionEditorTextEvent) => void): () => void;
}
