/** Safe migration diagnostics: paths relative to the source, never file contents. */
export interface StorageMigrationWarning {
	path: string;
	reason: "missing-link-target";
}

/** Desktop startup only. No credentials, history contents, or renderer-selected filesystem paths. */
export interface StorageStartupState {
	phase:
		| "inspecting"
		| "choice"
		| "scanning"
		| "review"
		| "existing"
		| "copying"
		| "preferences"
		| "error"
		| "ready"
		| "launching";
	workPhase?: "scan" | "copy" | "verify" | "publish" | "preferences";
	totalFiles?: number;
	totalBytes?: number;
	retryable?: boolean;
	canReturn?: boolean;
	recoveryPath?: string;
	source: string | null;
	target: string;
	files: number;
	bytes: number;
	external: string[];
	warnings?: StorageMigrationWarning[];
	error?: string;
}
export type StorageStartupAction = "scan" | "back" | "copy" | "empty" | "adopt" | "retry" | "cancel" | "exit";
