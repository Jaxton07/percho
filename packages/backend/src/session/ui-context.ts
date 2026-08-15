import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PermissionGate } from "../permissions/gate";

/**
 * ExtensionUIContext 全量 no-op 实现：只桥接权限确认（confirm），其余保持默认。
 * SDK 接口变化时在这里补齐新成员，别在 PiBackend 里重写。
 */
export function makeUiContext(gate: PermissionGate): ExtensionUIContext {
	return {
		select: (title, options) =>
			gate.confirm(title, options.join(", ")).then((ok) => (ok ? options[0] : undefined)),
		confirm: (title, message) => gate.confirm(title, message),
		input: (title) => gate.confirm(title, "允许输入?").then((ok) => (ok ? "" : undefined)),
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
