import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** 一个调用只启动一个worker，收到结果后仍等待实际退出才释放槽位。 */
export function runMaintenanceWorker<T>(
	data: Record<string, unknown>,
	options: {
		workerPath?: string;
		onWorker?: (worker: Worker) => void;
		onProgress?: (done: number, total: number) => void;
		onRequest?: (type: string, payload: unknown) => Promise<unknown>;
	} = {},
): Promise<T> {
	const directory = dirname(fileURLToPath(import.meta.url));
	const source = join(directory, "media-maintenance-worker.ts");
	const path =
		options.workerPath ?? (existsSync(source) ? source : join(directory, "session-media-worker.mjs"));
	return new Promise((resolve, reject) => {
		const worker = new Worker(path, {
			workerData: data,
			execArgv: path.endsWith(".ts") ? ["--experimental-strip-types"] : [],
			resourceLimits: { maxOldGenerationSizeMb: 384 },
		});
		options.onWorker?.(worker);
		let result: T | undefined,
			completed = false,
			failure: Error | undefined;
		const pending = new Set<Promise<void>>();
		worker.on(
			"message",
			(message: {
				type: string;
				result?: T;
				error?: string;
				processedBytes?: number;
				totalBytes?: number;
				requestId?: number;
				payload?: unknown;
			}) => {
				if (message.type === "progress")
					options.onProgress?.(message.processedBytes ?? 0, message.totalBytes ?? 0);
				else if (message.type === "result") {
					completed = true;
					result = message.result;
				} else if (message.type === "error")
					failure = new Error(message.error ?? "Maintenance worker failed");
				else if (message.requestId !== undefined) {
					const id = message.requestId;
					const request: Promise<void> = Promise.resolve()
						.then(() => {
							if (!options.onRequest) throw new Error("Unexpected maintenance worker request");
							return options.onRequest(message.type, message.payload);
						})
						.then(
							(value) => worker.postMessage({ requestId: id, value }),
							(error) =>
								worker.postMessage({
									requestId: id,
									error: error instanceof Error ? error.message : "Maintenance request failed",
								}),
						)
						.catch((error) => {
							failure = error instanceof Error ? error : new Error(String(error));
						})
						.finally(() => pending.delete(request));
					pending.add(request);
				}
			},
		);
		worker.once("error", (error) => {
			failure = error;
		});
		worker.once("exit", async (code) => {
			await Promise.allSettled([...pending]);
			if (failure) reject(failure);
			else if (!completed) reject(new Error(`Maintenance worker exited before completion (${code})`));
			else resolve(result as T);
		});
	});
}
