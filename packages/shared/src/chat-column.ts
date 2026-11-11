/** Default intended chat-column max-width (px), also used for invalid saved values. */
export const CHAT_COLUMN_DEFAULT_WIDTH = 760;
export const CHAT_COLUMN_MIN_WIDTH = 480;

/** Normalize user intent; CSS clamps the actual width to the container, so there is no fixed maximum. */
export function normalizeChatColumnWidth(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return CHAT_COLUMN_DEFAULT_WIDTH;
	return Math.max(CHAT_COLUMN_MIN_WIDTH, Math.round(value));
}
