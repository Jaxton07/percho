import {
	initializeLocalStorage,
	inspectLocalStorage,
	type LocalStorageRecord,
	migrateNavigation,
	type StorageInspection,
	type StorageProgress,
} from "@percho/backend";
import type { StorageStartupAction, StorageStartupState } from "@percho/shared";
import {
	type LocalStorageSelection,
	validateStorageSelection,
} from "../../../backend/src/storage/path-policy";

export class StorageStartupController {
	state: StorageStartupState;
	private inspection?: StorageInspection;
	private selection?: LocalStorageSelection;
	private abort?: AbortController;
	private busy = false;
	private exiting = false;
	private lastProgress = 0;
	private progress(progress: StorageProgress) {
		if (progress.phase !== this.state.workPhase || Date.now() - this.lastProgress >= 100) {
			this.lastProgress = Date.now();
			this.update({
				workPhase: progress.phase,
				files: progress.files,
				bytes: progress.bytes,
				...(progress.totalBytes === undefined
					? {}
					: { totalBytes: progress.totalBytes, totalFiles: progress.totalFiles }),
			});
		}
	}
	constructor(
		private readonly options: {
			selection?: LocalStorageSelection;
			error?: Error;
			userData: string;
			onChange: (state: StorageStartupState) => void;
			onReady: (record: LocalStorageRecord, selection: LocalStorageSelection) => void;
			onExit: () => void;
		},
	) {
		this.state = {
			phase: "inspecting",
			source: options.selection?.source ?? null,
			target: options.selection?.target ?? "",
			files: 0,
			bytes: 0,
			external: [],
		};
	}
	private update(patch: Partial<StorageStartupState>) {
		this.state = { ...this.state, ...patch };
		this.options.onChange(this.state);
	}
	start(): void {
		this.run(async () => {
			if (this.options.error) throw this.options.error;
			if (!this.options.selection) throw new Error("Missing storage selection");
			this.update({
				phase: "inspecting",
				error: undefined,
				retryable: true,
				workPhase: "scan",
				files: 0,
				bytes: 0,
				totalFiles: undefined,
				totalBytes: undefined,
			});
			this.selection = await validateStorageSelection(this.options.selection);
			process.env.PI_CODING_AGENT_DIR = this.selection.target;
			const inspection = await inspectLocalStorage(this.selection, {
				signal: this.abort?.signal,
				onProgress: (p) => this.progress(p),
			});
			this.inspection = inspection;
			this.update({
				target: this.selection.target,
				source: this.selection.source,
				files: inspection.files,
				bytes: inspection.bytes,
				totalFiles: inspection.files,
				totalBytes: inspection.bytes,
				external: inspection.external,
			});
			if (inspection.record) await this.finish(inspection.record);
			else if (inspection.state === "new") await this.initialize("empty");
			else this.update({ phase: inspection.state === "existing" ? "existing" : "choice" });
		});
	}
	act(action: StorageStartupAction): void {
		if (action === "cancel" || action === "exit") {
			this.exiting = true;
			this.abort?.abort();
			if (!this.busy) this.options.onExit();
			return;
		}
		if (this.state.phase === "ready" || this.state.phase === "launching")
			throw new Error("Storage startup has completed");
		if (this.busy) throw new Error("Storage preparation is busy");
		if (action === "retry") {
			if (this.state.retryable === false) throw new Error("Restart the application to retry initialization");
			this.start();
			return;
		}
		if ((this.state.phase !== "choice" && this.state.phase !== "existing") || !this.inspection)
			throw new Error("Inspect storage before choosing");
		this.run(() => this.initialize(action));
	}
	/** Business IPC is registered before this signal allows the renderer to import the workbench. */
	launchWorkbench(): void {
		if (this.exiting || this.state.phase !== "ready") return;
		this.update({ phase: "launching" });
	}
	failWorkbench(error: unknown): void {
		if (!this.exiting)
			this.update({
				phase: "error",
				retryable: false,
				error: error instanceof Error ? error.message : String(error),
			});
	}
	private run(task: () => Promise<void>) {
		if (this.busy) return;
		this.busy = true;
		this.abort = new AbortController();
		void task()
			.catch((error) => {
				if (!this.exiting)
					this.update({ phase: "error", error: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => {
				this.busy = false;
				if (this.exiting) this.options.onExit();
			});
	}
	private async initialize(choice: "copy" | "empty" | "adopt") {
		if (!this.inspection) throw new Error("Missing storage inspection");
		this.update({ phase: "copying", workPhase: "scan", files: 0, bytes: 0, error: undefined });
		const record = await initializeLocalStorage(this.inspection, choice, {
			signal: this.abort?.signal,
			onProgress: (p) => this.progress(p),
		});
		await this.finish(record);
	}
	private async finish(record: LocalStorageRecord) {
		this.update({ phase: "preferences" });
		await migrateNavigation(this.options.userData, record);
		if (this.exiting) return;
		this.update({ phase: "ready" });
		this.options.onReady(record, this.selection as LocalStorageSelection);
	}
}
