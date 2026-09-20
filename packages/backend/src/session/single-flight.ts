/**
 * 按 key 的并发 single-flight 原语（spec sidebar-session-switch-stability D4）：
 * 同一 key 在途时复用同一个 Promise（多个调用者拿到同一结果），settle 后**无论成败**都清 key，
 * 故失败可以重试；不同 key 互不影响。
 *
 * 为什么单独成文件：PiBackend 的构造路径依赖真实 SDK/资源加载，无法在单测里无侵入地多次构造，
 * 把「按 key 去重」这层纯逻辑抽出来才能确定性单测（见 test/session-single-flight.test.ts）。
 *
 * 契约：`task` 必须返回 Promise（调用方均为 async 函数）；同 key 在途期间复用同一个 Promise；
 * settle（无论成败）后清 key，且只清「自己那一条」（settle 期间可能有新请求占用同一个 key，
 * 旧 Promise 不得把后继请求删掉）；不同 key 互不影响。
 */
export class KeyedSingleFlight<T> {
	private readonly inFlight = new Map<string, Promise<T>>();

	/** 在途任务数（单测断言「settle 后必然清空」用） */
	get size(): number {
		return this.inFlight.size;
	}

	run(key: string, task: () => Promise<T>): Promise<T> {
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = task().finally(() => {
			if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}
}
