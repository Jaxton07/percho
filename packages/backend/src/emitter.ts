/**
 * 泛型订阅/分发原语：单一事实源，PiBackend 的 9 套事件管线共用。
 *
 * 语义（对齐原手写 dispatch* 循环）：
 * - subscribe 返回退订函数（幂等：重复调用无害）
 * - emit 内 per-handler try-catch：单个处理器异常不影响主流程，也不影响其余处理器
 * - clear 用于 dispose（退订全部）
 */
export class Emitter<T> {
	private readonly handlers = new Set<(payload: T) => void>();

	subscribe(handler: (payload: T) => void): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	emit(payload: T): void {
		for (const handler of this.handlers) {
			try {
				handler(payload);
			} catch {
				// 处理器异常不影响主流程（与其他 handler 隔离）
			}
		}
	}

	/** 订阅者数量（如信任门控 canAsk 探测「有没有人在听」） */
	get size(): number {
		return this.handlers.size;
	}

	clear(): void {
		this.handlers.clear();
	}
}
