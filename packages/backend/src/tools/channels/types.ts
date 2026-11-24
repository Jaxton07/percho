export interface DeleteFingerprint {
	dev: number;
	ino: number;
	ctimeMs: number;
	mtimeMs: number;
	id: string;
	archiveOperationId?: string | null;
}

export interface ChannelActor {
	sessionId: string;
	sessionName?: string;
}
export interface ChannelManageParams {
	action: "create" | "subscribe" | "unsubscribe" | "list";
	topic?: string;
	scope?: "all" | "subscribed";
	limit?: number;
	cursor?: string;
}
export interface ChannelEntry {
	topic: string;
	subscribed: boolean;
	unread: number;
}
export interface ChannelManageResult {
	channels: ChannelEntry[];
	nextCursor?: string;
}
export interface ChannelSnapshotEntry {
	topic: string;
	unread: number;
}
export interface ChannelMessage {
	id: string;
	topic: string;
	sender: string;
	name: string;
	at: string;
	body: string;
}
export interface ChannelReadParams {
	topic: string;
	mode?: "unread" | "recent" | "start";
	cursor?: string;
	limit?: number;
}
export interface ChannelReadResult {
	mode: "unread" | "recent" | "start";
	messages: ChannelMessage[];
	direction: "older" | "newer";
	upper: string;
	count: number;
	stopReason: "end" | "limit" | "budget";
	hasMore: boolean;
	nextCursor?: string;
	unread: number;
}
export interface ChannelFence {
	sessionId: string;
	opId: string;
	kind: "archive" | "delete";
	source: string;
	state: "archive" | "delete" | "archived" | "deleted";
}
