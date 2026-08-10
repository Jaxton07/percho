import { useT } from "../../i18n";

/** MCP 设置面板：当前 pi SDK 暂不支持 MCP，说明占位 */
export function McpPanel() {
	const t = useT();
	return <p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.mcp.unsupported")}</p>;
}
