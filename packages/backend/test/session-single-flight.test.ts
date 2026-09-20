import { describe, expect, it } from "vitest";
import { KeyedSingleFlight } from "../src/session/single-flight";

/** 手写 deferred：single-flight 的契约全在「settle 前 / settle 后」两个时刻，必须能精确控制 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * 阶段 0 红测（spec D4 / §5 Backend 1）：同一路径并发 open 只构造一次，
 * 靠这层原语保证；失败可重试靠「settle 必清 key」。
 */
describe("KeyedSingleFlight", () => {
	it("同一 key 在途时只执行一次，多个调用者拿到同一结果", async () => {
		const flight = new KeyedSingleFlight<number>();
		const pending = deferred<number>();
		let calls = 0;
		const task = () => {
			calls += 1;
			return pending.promise;
		};

		const first = flight.run("k", task);
		const second = flight.run("k", task);

		expect(calls).toBe(1);
		expect(flight.size).toBe(1);
		pending.resolve(7);
		expect(await Promise.all([first, second])).toEqual([7, 7]);
	});

	it("settle 后清 key：同一个 key 再次调用会重新执行", async () => {
		const flight = new KeyedSingleFlight<number>();
		let calls = 0;
		const task = () => {
			calls += 1;
			return Promise.resolve(calls);
		};

		await flight.run("k", task);
		expect(flight.size).toBe(0);
		expect(await flight.run("k", task)).toBe(2);
		expect(calls).toBe(2);
	});

	it("失败也清 key：可重试（失败 Promise 不留在表里）", async () => {
		const flight = new KeyedSingleFlight<number>();
		const failing = deferred<number>();
		const first = flight.run("k", () => failing.promise);
		failing.reject(new Error("boom"));
		await expect(first).rejects.toThrow("boom");

		expect(flight.size).toBe(0);
		expect(await flight.run("k", () => Promise.resolve(1))).toBe(1);
	});

	it("不同 key 并发互不影响（各自独立执行）", async () => {
		const flight = new KeyedSingleFlight<string>();
		const a = deferred<string>();
		const b = deferred<string>();

		const first = flight.run("a", () => a.promise);
		const second = flight.run("b", () => b.promise);
		expect(flight.size).toBe(2);
		a.resolve("A");
		b.resolve("B");
		expect(await Promise.all([first, second])).toEqual(["A", "B"]);
	});
});
