import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { PermissionGate } from "../permissions/gate";

/**
 * 提供给扩展的契约 Theme 实例（中性暗色盘，truecolor）。
 *
 * pi 扩展契约要求 ctx.ui.theme 是带 fg()/bg()/bold() 等方法的 Theme 对象（extensions.md
 * 标准用法）；桌面端 GUI 无 TUI 状态栏，样式输出全部落到 no-op sink，但对象本身必须真
 * （issue #28：pi-mcp-adapter 在 updateStatusBar 里 ui.theme.fg("accent", ...) 空对象/字符串
 * 直接抛 TypeError，全部 MCP 服务器连接失败）。用真实 Theme 类实例保证全部 12+ 方法存在，
 * 而非手写 pass-through 对象（进了一支扩展调用 italic()/getFgAnsi() 还是会崩）。
 *
 * 色盘为静态中性色：桌面端不消费 ANSI 输出，无需跟随 GUI 亮暗主题；构造参数受 TS 约束，
 * SDK 升级新增必填色时 typecheck 会报错提醒补齐。Theme 构造纯内存计算，无环境依赖。
 */
const EXTENSION_THEME = new Theme(
	{
		accent: "#7aa2f7",
		border: "#3b4261",
		borderAccent: "#7aa2f7",
		borderMuted: "#292e42",
		success: "#9ece6a",
		error: "#f7768e",
		warning: "#e0af68",
		muted: "#78849b",
		dim: "#565f89",
		text: "#c0caf5",
		thinkingText: "#9d7cd8",
		userMessageText: "#c0caf5",
		customMessageText: "#c0caf5",
		customMessageLabel: "#7aa2f7",
		toolTitle: "#7dcfff",
		toolOutput: "#a9b1d6",
		mdHeading: "#7aa2f7",
		mdLink: "#7dcfff",
		mdLinkUrl: "#565f89",
		mdCode: "#9ece6a",
		mdCodeBlock: "#a9b1d6",
		mdCodeBlockBorder: "#3b4261",
		mdQuote: "#a9b1d6",
		mdQuoteBorder: "#3b4261",
		mdHr: "#3b4261",
		mdListBullet: "#7dcfff",
		toolDiffAdded: "#9ece6a",
		toolDiffRemoved: "#f7768e",
		toolDiffContext: "#565f89",
		syntaxComment: "#565f89",
		syntaxKeyword: "#bb9af7",
		syntaxFunction: "#7aa2f7",
		syntaxVariable: "#e0af68",
		syntaxString: "#9ece6a",
		syntaxNumber: "#ff9e64",
		syntaxType: "#2ac3de",
		syntaxOperator: "#89ddff",
		syntaxPunctuation: "#c0caf5",
		thinkingOff: "#565f89",
		thinkingMinimal: "#6183bb",
		thinkingLow: "#7aa2f7",
		thinkingMedium: "#89ddff",
		thinkingHigh: "#b4f9f8",
		thinkingXhigh: "#d2e5ff",
		bashMode: "#e0af68",
	},
	{
		selectedBg: "#33467c",
		userMessageBg: "#24283b",
		customMessageBg: "#1f2335",
		toolPendingBg: "#2f334d",
		toolSuccessBg: "#20303b",
		toolErrorBg: "#2d202a",
	},
	"truecolor",
	{ name: "percho-desktop" },
);

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
		theme: EXTENSION_THEME,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
