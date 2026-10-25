/**
 * 「在文件管理器中显示」的文案随平台变：macOS 是 Finder，Windows 是资源管理器，其余叫文件管理器。
 * 独立成纯函数模块（不碰 `window.pi`、不含 JSX），方便单测。
 */
export function revealLabelKey(
	platform: string,
): "sidebar.revealInFinder" | "sidebar.revealInExplorer" | "sidebar.revealInFileManager" {
	if (platform === "darwin") return "sidebar.revealInFinder";
	if (platform === "win32") return "sidebar.revealInExplorer";
	return "sidebar.revealInFileManager";
}
