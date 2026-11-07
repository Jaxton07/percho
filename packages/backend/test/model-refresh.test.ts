import { expect, it } from "vitest";
import { ModelRefreshCoordinator } from "../src/settings/model-refresh";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function turn() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

it("取消排队 caller 立即结算，不能越过执行中的任务", async () => {
	const queue = new ModelRefreshCoordinator();
	const gate = deferred();
	const started = deferred();
	const order: string[] = [];
	const first = queue.run(async () => {
		started.resolve();
		await gate.promise;
		order.push("first");
	});
	await started.promise;
	const controller = new AbortController();
	const pending = queue.run(async () => {
		order.push("cancelled");
	}, controller.signal);
	const settled = pending.then(
		() => "resolved",
		() => "rejected",
	);
	const last = queue.run(async () => {
		order.push("last");
	});
	try {
		controller.abort();
		expect(await Promise.race([settled, turn().then(() => "blocked")])).toBe("rejected");
		expect(order).toEqual([]);
	} finally {
		gate.resolve();
		await Promise.allSettled([first, pending, last]);
	}
	expect(order).toEqual(["first", "last"]);
});

it("已执行任务的 caller 取消不提前释放队列或 join", async () => {
	const queue = new ModelRefreshCoordinator();
	const gate = deferred();
	const started = deferred();
	const controller = new AbortController();
	const order: string[] = [];
	const first = queue.run(async () => {
		started.resolve();
		await gate.promise;
		order.push("first");
	}, controller.signal);
	const settled = first.then(
		() => "resolved",
		() => "rejected",
	);
	await started.promise;
	const last = queue.run(async () => {
		order.push("last");
	});
	let joined = false;
	const join = queue.join().then(() => {
		joined = true;
	});
	try {
		controller.abort();
		expect(await Promise.race([settled, turn().then(() => "blocked")])).toBe("rejected");
		expect(order).toEqual([]);
		expect(joined).toBe(false);
	} finally {
		gate.resolve();
		await Promise.allSettled([first, last, join]);
	}
	expect(order).toEqual(["first", "last"]);
	expect(joined).toBe(true);
});
