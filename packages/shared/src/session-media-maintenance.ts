/** 单文件显式维护；启动成功仅代表接受后台任务，不代表文件已改变。 */
export interface SessionMediaPreview {
	supported: boolean;
	reason?: "unsupported-version" | "invalid-header" | "no-benefit";
	sourceVersion?: number;
	sourceHash: string;
	sourceFingerprint: string;
	sessionId?: string;
	fileBytes: number;
	projectedFileBytes: number;
	imageCount: number;
	uniqueImages: number;
	originalImageBytes: number;
	backupBytes: number;
	/** 保守估算：备份+候选+全部新媒体，不把备份当作节省。 */
	additionalPeakBytes: number;
	invalidLines: number;
	skippedImages: number;
}
export type SessionMediaJobStatus =
	| "queued"
	| "running"
	| "cancelling"
	| "cancelled"
	| "completed"
	| "failed";
export interface SessionMediaJob {
	jobId: string;
	kind: "preview";
	sessionFile: string;
	status: SessionMediaJobStatus;
	processedBytes: number;
	totalBytes: number;
	createdAt: number;
	updatedAt: number;
	result?: SessionMediaPreview;
	error?: string;
}
