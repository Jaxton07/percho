import {
	type DisplayImage,
	type EnvironmentRef,
	environmentEntityRef,
	environmentKey,
	type ImageInput,
	isReferenceImage,
} from "@percho/shared";
import { getExecutionApi } from "../../../environment-api";

type Waiter = { resolve: (image: ImageInput) => void; reject: (error: unknown) => void; off: () => void };
type Job = { key: string; environment: string; image: DisplayImage; started: boolean; waiters: Set<Waiter> };

/** 只合并在途单图请求，不缓存原图；不同环境最多2个，同环境最多1个。 */
export function createImageReader(fetchImage: (image: DisplayImage) => Promise<ImageInput>) {
	const jobs = new Map<string, Job>();
	const queue: Job[] = [];
	const activeEnvironments = new Set<string>();
	let active = 0;
	let peak = 0;
	let requests = 0,
		completed = 0,
		errors = 0,
		milliseconds = 0;
	function pump(): void {
		for (let index = 0; index < queue.length && active < 2; ) {
			const job = queue[index];
			if (!job) break;
			if (!job.waiters.size) {
				queue.splice(index, 1);
				jobs.delete(job.key);
				continue;
			}
			if (activeEnvironments.has(job.environment)) {
				index++;
				continue;
			}
			queue.splice(index, 1);
			job.started = true;
			active++;
			peak = Math.max(peak, active);
			activeEnvironments.add(job.environment);
			const started = performance.now();
			void Promise.resolve()
				.then(() => {
					if (!job.waiters.size) throw new Error("Image subscription cancelled");
					requests++;
					return fetchImage(job.image);
				})
				.then(
					(image) => {
						completed++;
						if (jobs.get(job.key) === job) jobs.delete(job.key);
						for (const waiter of job.waiters) {
							waiter.off();
							waiter.resolve(image);
						}
						job.waiters.clear();
					},
					(error: unknown) => {
						if (job.waiters.size) errors++;
						if (jobs.get(job.key) === job) jobs.delete(job.key);
						for (const waiter of job.waiters) {
							waiter.off();
							waiter.reject(error);
						}
						job.waiters.clear();
					},
				)
				.finally(() => {
					milliseconds += performance.now() - started;
					job.waiters.clear();
					if (jobs.get(job.key) === job) jobs.delete(job.key);
					active--;
					activeEnvironments.delete(job.environment);
					pump();
				});
		}
	}
	async function read(image: DisplayImage, signal?: AbortSignal): Promise<ImageInput> {
		if (!isReferenceImage(image)) return Promise.resolve(image);
		if (signal?.aborted) return Promise.reject(new Error("Image subscription cancelled"));
		const environment = environmentKey(environmentEntityRef(image.ownerSessionId).environment);
		const key = JSON.stringify([image.ownerSessionId, image.id, image.revision]);
		let job = jobs.get(key);
		if (!job) {
			if (queue.length >= 48) return Promise.reject(new Error("Image read queue is full"));
			job = { key, environment, image, started: false, waiters: new Set() };
			jobs.set(key, job);
			queue.push(job);
		}
		const target = job;
		return new Promise<ImageInput>((resolve, reject) => {
			const cancel = () => {
				target.waiters.delete(waiter);
				waiter.off();
				reject(new Error("Image subscription cancelled"));
				if (!target.started && !target.waiters.size) pump();
			};
			const waiter: Waiter = { resolve, reject, off: () => signal?.removeEventListener("abort", cancel) };
			target.waiters.add(waiter);
			signal?.addEventListener("abort", cancel, { once: true });
			pump();
		});
	}
	function invalidate(matches: (job: Job) => boolean): void {
		for (const job of [...jobs.values()]) {
			if (!matches(job)) continue;
			jobs.delete(job.key);
			const index = queue.indexOf(job);
			if (index >= 0) queue.splice(index, 1);
			const waiters = [...job.waiters];
			job.waiters.clear();
			for (const waiter of waiters) {
				waiter.off();
				waiter.reject(new Error("Image source was invalidated"));
			}
		}
		// 仍在执行的RPC保留真实并发占位，旧回应不能删同key新任务。
		pump();
	}
	return {
		read,
		invalidateEnvironment: (environment: EnvironmentRef) =>
			invalidate((job) => job.environment === environmentKey(environment)),
		invalidateOwner: (owner: string) =>
			invalidate((job) => isReferenceImage(job.image) && job.image.ownerSessionId === owner),
		stats: () => ({
			active,
			queued: queue.length,
			jobs: jobs.size,
			peak,
			requests,
			completed,
			errors,
			milliseconds,
		}),
	};
}

export const imageReader = createImageReader(async (image) => {
	if (!isReferenceImage(image)) return image;
	// 来源已由消息的环境适配器绑定，绝不使用当前选中环境或activeSessionId。
	const result = await getExecutionApi(image.ownerSessionId).getSessionImage({
		sessionId: image.ownerSessionId,
		imageId: image.id,
		revision: image.revision,
	});
	return { data: result.data, mimeType: result.mimeType };
});
