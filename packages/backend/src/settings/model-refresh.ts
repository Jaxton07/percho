/** 仅协调宿主入口；不改写 SDK refresh，也不影响 SDK 内部注册逻辑。 */
export class ModelRefreshCoordinator {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		const result = this.tail.then(() => {
			signal?.throwIfAborted();
			return work();
		});
		// caller 取消不释放正在执行的工作；后继任务与 join 仍等待真实完成。
		this.tail = result.catch(() => {});
		if (!signal) return result;
		return new Promise<T>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	}

	async join(): Promise<void> {
		await this.tail;
	}
}
