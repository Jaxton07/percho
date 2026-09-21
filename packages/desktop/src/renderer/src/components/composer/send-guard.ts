/**
 * 同步发送锁（Composer 的 handleSend 专用）。
 *
 * 为什么不能用 `sending` state：React state 要等下一次渲染才生效，而首条消息在 draft 页
 * 需要先 `await createSession()` 转正 —— 这个 await 窗口里 `sending` 还是 false，
 * 两次 Enter（或 Enter + 发命令）都会通过校验、共享同一次 createSession，
 * 然后**各自 prompt 一遍**（同一句话发两次）。
 *
 * 所以用一个同步（ref 持有）的锁，从校验通过一直握到本次发送真正结束，
 * 覆盖所有 early return（在调用方用 try/finally 释放）。
 */
export interface SendGuard {
	/** 抢锁：true = 抢到（可以发），false = 已有一轮在途（直接忽略这次触发） */
	tryAcquire: () => boolean;
	release: () => void;
}

export function createSendGuard(): SendGuard {
	let locked = false;
	return {
		tryAcquire: () => {
			if (locked) return false;
			locked = true;
			return true;
		},
		release: () => {
			locked = false;
		},
	};
}
