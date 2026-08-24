import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PermissionGate } from "../permissions/gate";

/**
 * ExtensionUIContext 全量 no-op 实现：只桥接权限确认（confirm），其余保持默认。
 * SDK 接口变化时在这里补齐新成员，别在 PiBackend 里重写。
 */
export function makeUiContext(gate: PermissionGate): ExtensionUIContext {
	return {
		// SDK 契约：select/input 的 undefined = 用户取消（types.d.ts），合法返回值；GUI 无对应
		// 交互 UI，一律取消，不伪造「第一项/空串」当作用户输入（D8）
		select: (_title, _options) => Promise.resolve(undefined),
		confirm: (title, message) => gate.confirm(title, message),
		input: (_title) => Promise.resolve(undefined),
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: (async () => undefined) as ExtensionUIContext["custom"],
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {} as ExtensionUIContext["theme"],
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
