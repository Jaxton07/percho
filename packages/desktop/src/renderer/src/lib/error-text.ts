/** toast detail 展示：剥掉 Electron IPC 包装前缀（`Error invoking remote method 'x': Error: `），截断只留首段 */
export function errText(error: unknown): string | undefined {
	let message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	if (!message) return undefined;
	message = message.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "");
	return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}
