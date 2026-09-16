import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../src/emitter";

describe("Emitter", () => {
	it("subscribe 后 emit 收到载荷，退订后不再收到", () => {
		const emitter = new Emitter<number>();
		const handler = vi.fn();
		const unsubscribe = emitter.subscribe(handler);

		emitter.emit(1);
		expect(handler).toHaveBeenCalledWith(1);

		unsubscribe();
		emitter.emit(2);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("emit 广播给全部订阅者", () => {
		const emitter = new Emitter<string>();
		const a = vi.fn();
		const b = vi.fn();
		emitter.subscribe(a);
		emitter.subscribe(b);

		emitter.emit("x");
		expect(a).toHaveBeenCalledWith("x");
		expect(b).toHaveBeenCalledWith("x");
	});

	it("单个处理器异常不影响主流程与其余处理器", () => {
		const emitter = new Emitter<number>();
		const bad = vi.fn(() => {
			throw new Error("boom");
		});
		const good = vi.fn();
		emitter.subscribe(bad);
		emitter.subscribe(good);

		expect(() => emitter.emit(42)).not.toThrow();
		expect(bad).toHaveBeenCalledWith(42);
		expect(good).toHaveBeenCalledWith(42);
	});

	it("clear 退订全部（dispose 用）", () => {
		const emitter = new Emitter<number>();
		const handler = vi.fn();
		emitter.subscribe(handler);

		emitter.clear();
		emitter.emit(1);
		expect(handler).not.toHaveBeenCalled();
		expect(emitter.size).toBe(0);
	});

	it("size 反映当前订阅数", () => {
		const emitter = new Emitter<null>();
		expect(emitter.size).toBe(0);
		const unsubscribe = emitter.subscribe(() => {});
		expect(emitter.size).toBe(1);
		unsubscribe();
		expect(emitter.size).toBe(0);
	});
});
