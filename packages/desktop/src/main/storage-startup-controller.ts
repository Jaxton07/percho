import {
	initializeLocalStorage,
	inspectLocalStorage,
	type LocalStorageRecord,
	migrateNavigation,
	StorageInitializationError,
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
	private published?: LocalStorageRecord;
	private abort?: AbortController;
	private busy = false;
	private offeredChoice = false;
	private exiting = false;
	private returning = false;
	private taskId = 0;
	private lastProgress = 0;
	private operation: "probe" | "scan" | "initialize" | "finish" = "probe";
	private initializationChoice?: "copy" | "empty" | "adopt";

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
	private settled(patch: Partial<StorageStartupState>) {
		this.busy = false;
		this.update(patch);
	}
	private progress(progress: StorageProgress) {
		if (this.returning || this.exiting) return;
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
	start(): void {
		this.run("probe", async () => {
			if (this.options.error) throw this.options.error;
			if (!this.options.selection) throw new Error("Missing storage selection");
			this.update({
				phase: "inspecting",
				error: undefined,
				retryable: true,
				canReturn: false,
				recoveryPath: undefined,
				workPhase: "scan",
				files: 0,
				bytes: 0,
				totalFiles: undefined,
				totalBytes: undefined,
				external: [],
				warnings: [],
			});
			this.selection = await validateStorageSelection(this.options.selection);
			process.env.PI_CODING_AGENT_DIR = this.selection.target;
			const inspection = await inspectLocalStorage(this.selection, {
				scanSource: false,
				signal: this.abort?.signal,
			});
			this.inspection = inspection;
			this.update({ target: this.selection.target, source: this.selection.source });
			if (inspection.record) await this.finish(inspection.record);
			else if (inspection.state === "new" && !this.offeredChoice) await this.initialize("empty");
			else {
				const phase = inspection.state === "existing" ? "existing" : "choice";
				if (phase === "choice") this.offeredChoice = true;
				this.settled({ phase });
			}
		});
	}
	private scan() {
		this.run("scan", async () => {
			if (!this.selection) throw new Error("Missing storage selection");
			this.inspection = undefined;
			this.update({
				phase: "scanning",
				error: undefined,
				recoveryPath: undefined,
				canReturn: true,
				workPhase: "scan",
				files: 0,
				bytes: 0,
				totalFiles: undefined,
				totalBytes: undefined,
				external: [],
				warnings: [],
			});
			const inspection = await inspectLocalStorage(this.selection, {
				signal: this.abort?.signal,
				onProgress: (p) => this.progress(p),
			});
			if (this.returning || this.exiting) return;
			if (inspection.record) return this.finish(inspection.record);
			if (inspection.state !== "import") throw new Error("Storage changed; inspect it again before choosing");
			this.inspection = inspection;
			this.settled({
				phase: "review",
				files: inspection.files,
				bytes: inspection.bytes,
				totalFiles: inspection.files,
				totalBytes: inspection.bytes,
				external: inspection.external,
				warnings: inspection.warnings,
			});
		});
	}
	act(action: StorageStartupAction): void {
		if (action === "cancel" || action === "exit") {
			this.exiting = true;
			this.abort?.abort();
			if (!this.busy) this.options.onExit();
			return;
		}
		if (action === "back" && this.state.phase === "scanning" && this.busy) {
			this.returning = true;
			this.abort?.abort();
			return;
		}
		if (this.state.phase === "ready" || this.state.phase === "launching")
			throw new Error("Storage startup has completed");
		if (this.busy) throw new Error("Storage preparation is busy");
		if (
			action === "back" &&
			(this.state.phase === "review" || (this.state.phase === "error" && this.state.canReturn))
		) {
			this.inspection = undefined;
			this.start();
			return;
		}
		if (action === "retry" && this.state.phase === "error" && this.state.retryable !== false) {
			if (this.published) this.run("finish", () => this.finish(this.published as LocalStorageRecord));
			else if (
				this.operation === "scan" ||
				(this.operation === "initialize" && this.initializationChoice === "copy")
			)
				this.scan();
			else this.start();
			return;
		}
		if (action === "retry" && this.state.retryable === false)
			throw new Error("Restart the application to retry initialization");
		if (action === "scan" && (this.state.phase === "choice" || this.state.phase === "review")) {
			this.scan();
			return;
		}
		if (
			(action === "copy" && this.state.phase === "review") ||
			(action === "empty" && this.state.phase === "choice") ||
			(action === "adopt" && this.state.phase === "existing")
		) {
			this.run("initialize", () => this.initialize(action));
			return;
		}
		throw new Error("Action is not available in the current storage state");
	}
	launchWorkbench(): void {
		if (!this.exiting && this.state.phase === "ready") this.update({ phase: "launching" });
	}
	failWorkbench(error: unknown): void {
		if (!this.exiting)
			this.update({
				phase: "error",
				retryable: false,
				canReturn: false,
				error: error instanceof Error ? error.message : String(error),
			});
	}
	private run(operation: typeof this.operation, task: () => Promise<void>) {
		if (this.busy) return;
		this.busy = true;
		this.operation = operation;
		this.abort = new AbortController();
		const id = ++this.taskId;
		void task()
			.catch(async (error: unknown) => {
				if (!this.exiting && !this.returning && id === this.taskId) {
					let canReturn = !this.published && operation === "scan";
					if (!this.published && operation === "initialize" && this.selection) {
						// Publication may have succeeded even if its final lock release failed.
						// Read disk state after the initializer settles, never offer a destructive restart.
						try {
							const current = await inspectLocalStorage(this.selection, { scanSource: false });
							if (current.record) this.published = current.record;
							canReturn =
								this.initializationChoice !== "adopt" &&
								(current.state === "candidate" || current.state === "new");
						} catch {
							canReturn = false;
						}
					}
					if (this.exiting || id !== this.taskId) return;
					const recoveryPath =
						typeof error === "object" &&
						error !== null &&
						"recoveryPath" in error &&
						typeof error.recoveryPath === "string"
							? error.recoveryPath
							: undefined;
					const lockReleased = !(error instanceof StorageInitializationError) || error.lockReleased;
					this.settled({
						phase: "error",
						retryable: !!this.published || lockReleased,
						canReturn: canReturn && lockReleased,
						recoveryPath,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})
			.finally(() => {
				if (id !== this.taskId) return;
				this.busy = false;
				if (this.exiting) this.options.onExit();
				else if (this.returning) {
					this.returning = false;
					this.start();
				}
			});
	}
	private async initialize(choice: "copy" | "empty" | "adopt") {
		if (!this.inspection) throw new Error("Missing storage inspection");
		this.initializationChoice = choice;
		this.update({ phase: "copying", workPhase: "scan", files: 0, bytes: 0, error: undefined });
		const record = await initializeLocalStorage(this.inspection, choice, {
			signal: this.abort?.signal,
			onProgress: (p) => this.progress(p),
		});
		await this.finish(record);
	}
	private async finish(record: LocalStorageRecord) {
		this.published = record;
		this.update({ phase: "preferences", canReturn: false });
		await migrateNavigation(this.options.userData, record);
		if (this.exiting) return;
		this.settled({ phase: "ready", canReturn: false, error: undefined, recoveryPath: undefined });
		if (!this.exiting) this.options.onReady(record, this.selection as LocalStorageSelection);
	}
}
