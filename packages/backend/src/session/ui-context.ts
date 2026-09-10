import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionDialogHost } from "./extension-dialog-host";

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
 * 从 Error stack 推断调用方扩展名（notify/预填的展示归因，失败返回 ""）。
 *
 * 背景：uiContext 是会话级共享单例（SDK runner.createContext 直接返回同一对象，调用点
 * 不携带 extensionPath），fire-and-forget 调用无法精确归因。stack 启发式：跳过宿主
 * （@earendil-works 系）与加载器（jiti/tsx）帧后，找 ~/.pi/agent/extensions/<name>.* 或
 * npm 包 node_modules/<name>/ 的路径帧。纯函数，可单测。
 */
export function extensionNameFromStack(stack: string): string {
	for (const line of stack.split("\n")) {
		if (
			line.includes("@earendil-works") ||
			line.includes("node_modules/jiti/") ||
			line.includes("ui-context")
		) {
			continue;
		}
		const ext = line.match(/\/extensions\/([^/()\s]+?)\.(?:tsx?|mjs|cjs|js)(?:[?#:]|$)/);
		if (ext?.[1] && ext[1] !== "index") return ext[1];
		const pkg = line.match(/node_modules\/((?:@[\w.-]+\/)?[\w.-]+)\//);
		if (pkg?.[1]) return pkg[1];
	}
	return "";
}

/** makeUiContext 依赖（全可选：子代理 runner 传 {} 即得纯 no-op，保持既有语义） */
export interface UiContextDeps {
	/** 对话框宿主（每会话一个）；缺省 = 对话框退回契约取消值 */
	dialogs?: ExtensionDialogHost;
	/** notify → 全局 Toast（缺省丢弃）；source 为 stack 启发式归因（可能为空串） */
	onNotify?: (message: string, level: "info" | "warning" | "error", source: string) => void;
	/** setEditorText/pasteToEditor → Composer 草稿（缺省丢弃）；source 同上 */
	onEditorText?: (text: string, source: string) => void;
}

/**
 * ExtensionUIContext 实现：对话框四件套桥 ExtensionDialogHost（无 dialogs 时取消值兜底），
 * notify/setEditorText 走注入回调；confirm 不再路由 PermissionGate（D7：第三方 confirm 走
 * 通用中性确认卡，权限扩展用 options.confirm 直通道）。SDK 接口变化时在这里补齐新成员，
 * 别在 PiBackend 里重写。
 */
export function makeUiContext(deps: UiContextDeps = {}): ExtensionUIContext {
	return {
		// SDK 契约：select/input/editor 的 undefined = 用户取消（types.d.ts），confirm false = 否；
		// 无宿主时一律取消，不伪造「第一项/空串」当作用户输入（D3 诚实取消）
		select: (title, options, opts) =>
			deps.dialogs
				? deps.dialogs
						.ask("select", { title, options }, opts)
						.then((v) => (typeof v === "string" ? v : undefined))
				: Promise.resolve(undefined),
		confirm: (title, message, opts) =>
			deps.dialogs
				? deps.dialogs.ask("confirm", { title, message }, opts).then((v) => v === true)
				: Promise.resolve(false),
		input: (title, placeholder, opts) =>
			deps.dialogs
				? deps.dialogs
						.ask("input", placeholder ? { title, placeholder } : { title }, opts)
						.then((v) => (typeof v === "string" ? v : undefined))
				: Promise.resolve(undefined),
		notify: (message, type) =>
			deps.onNotify?.(message, type ?? "info", extensionNameFromStack(new Error().stack ?? "")),
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
		pasteToEditor: (text) => deps.onEditorText?.(text, extensionNameFromStack(new Error().stack ?? "")),
		setEditorText: (text) => deps.onEditorText?.(text, extensionNameFromStack(new Error().stack ?? "")),
		// 同步跨进程读草稿做不到；返回 ""（对齐官方 RPC 降级语义，spec 非目标）
		getEditorText: () => "",
		editor: (title, prefill) =>
			deps.dialogs
				? deps.dialogs
						.ask("editor", prefill ? { title, prefill } : { title }, undefined)
						.then((v) => (typeof v === "string" ? v : undefined))
				: Promise.resolve(undefined),
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: EXTENSION_THEME,
		getAllThemes: () => [],
		getTheme: () => undefined,
		// 诚实化（D10）：主题主权归宿主；假成功会让扩展据返回值分支误判
		setTheme: () => ({ success: false, error: "Theme switching is managed by Percho" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
