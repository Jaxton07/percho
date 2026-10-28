/** Desktop startup only. No credentials, history contents, or renderer-selected filesystem paths. */
export interface StorageStartupState {
	phase: "inspecting" | "choice" | "existing" | "copying" | "preferences" | "error" | "ready" | "launching";
	workPhase?: "scan" | "copy" | "verify" | "publish" | "preferences";
	totalFiles?: number;
	totalBytes?: number;
	retryable?: boolean;
	source: string | null;
	target: string;
	files: number;
	bytes: number;
	external: string[];
	error?: string;
}
export type StorageStartupAction = "copy" | "empty" | "adopt" | "retry" | "cancel" | "exit";
