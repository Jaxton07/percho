/** 页仅包含完整历史轮次；运行态/权限/队列不随前插页替换。 */
export interface SessionHistoryWindow {
	generation: string;
	sourceVersion: string;
	hydrationToken: string;
	hasOlder: boolean;
	cursor?: string;
	firstEntryId?: string;
	anchorEntryId?: string;
	/** 本次安装/前插涉及的源条目数；不是全SDK读取量。 */
	pageEntries: number;
	pageTurns: number;
}
