import { describe, expect, it } from "vitest";
import { createSendGuard } from "./send-guard";

describe("createSendGuard（发送的同步锁）", () => {
	it("第一轮抢到、第二轮在同 tick 被挡（这就是「两次 Enter 发两遍」的根因）", () => {
		const guard = createSendGuard();
		expect(guard.tryAcquire()).toBe(true);
		expect(guard.tryAcquire()).toBe(false);
		expect(guard.tryAcquire()).toBe(false);
	});

	it("release 后可再次发送（不在途时不能被永久锁死）", () => {
		const guard = createSendGuard();
		guard.tryAcquire();
		guard.release();
		expect(guard.tryAcquire()).toBe(true);
	});

	it("每个 guard 各自独立（多个 Composer 实例不互相锁）", () => {
		const a = createSendGuard();
		const b = createSendGuard();
		expect(a.tryAcquire()).toBe(true);
		expect(b.tryAcquire()).toBe(true);
	});

	it("模拟两轮并发发送：只有一轮穿过 await 窗口（promotion 只被驱动一次）", async () => {
		const guard = createSendGuard();
		let promotions = 0;
		const send = async () => {
			if (!guard.tryAcquire()) return "ignored";
			try {
				promotions += 1;
				await Promise.resolve(); // 相当于 ensureSession → createSession 的 await
				return "sent";
			} finally {
				guard.release();
			}
		};
		expect(await Promise.all([send(), send()])).toEqual(["sent", "ignored"]);
		expect(promotions).toBe(1);
	});
});
