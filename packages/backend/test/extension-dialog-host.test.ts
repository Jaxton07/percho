import type { ExtensionDialogRequest, ExtensionDialogResolved } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { ExtensionDialogHost } from "../src/session/extension-dialog-host";

function makeHost() {
	const requests: ExtensionDialogRequest[] = [];
	const resolved: ExtensionDialogResolved[] = [];
	const host = new ExtensionDialogHost({
		onRequest: (req) => requests.push(req),
		onResolved: (result) => resolved.push(result),
	});
	host.bind("s1");
	return { host, requests, resolved };
}

/** 假计时器环境（timeout 断言用 fake timers 推进，不真等） */
async function withFakeTimers(fn: () => Promise<void> | void) {
	vi.useFakeTimers();
	try {
		await fn();
	} finally {
		vi.useRealTimers();
	}
}

describe("ExtensionDialogHost", () => {
	it("ask 分发请求（id/sessionId/kind/title/options/requestedAt），respond 落用户值", async () => {
		const { host, requests, resolved } = makeHost();
		const promise = host.ask("select", { title: "选一个", options: ["a", "b"] });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			sessionId: "s1",
			kind: "select",
			title: "选一个",
			options: ["a", "b"],
		});
		expect(requests[0].id).toMatch(/^dlg-s1-\d+$/);
		expect(typeof requests[0].requestedAt).toBe("number");
		expect(requests[0].timeoutMs).toBeUndefined();

		host.respond(requests[0].id, { value: "b" });
		await expect(promise).resolves.toBe("b");
		expect(resolved).toEqual([{ sessionId: "s1", requestId: requests[0].id, reason: "answered" }]);
	});

	it("confirm：respond {confirmed:true} → true；{cancelled:true} → false（契约取消值）", async () => {
		const { host, requests } = makeHost();
		const yes = host.ask("confirm", { title: "t", message: "m" });
		host.respond(requests[0].id, { confirmed: true });
		await expect(yes).resolves.toBe(true);

		const no = host.ask("confirm", { title: "t2" });
		host.respond(requests[1].id, { cancelled: true });
		await expect(no).resolves.toBe(false);
	});

	it("confirm fail-closed：confirmed !== true 一律 false", async () => {
		const { host, requests } = makeHost();
		const promise = host.ask("confirm", { title: "t" });
		host.respond(requests[0].id, { confirmed: false });
		await expect(promise).resolves.toBe(false);
	});

	it("timeout 到点自动按取消值结算（select→undefined），onResolved reason=timeout", async () => {
		await withFakeTimers(async () => {
			const { host, requests, resolved } = makeHost();
			const promise = host.ask("select", { title: "t", options: ["a"] }, { timeout: 800 });
			expect(requests[0].timeoutMs).toBe(800);
			await vi.advanceTimersByTimeAsync(799);
			expect(requests).toHaveLength(1); // 未到点仍 pending
			await vi.advanceTimersByTimeAsync(1);
			await expect(promise).resolves.toBeUndefined();
			expect(resolved[0]?.reason).toBe("timeout");
		});
	});

	it("confirm 超时取消值 = false", async () => {
		await withFakeTimers(async () => {
			const { host } = makeHost();
			const promise = host.ask("confirm", { title: "t" }, { timeout: 500 });
			await vi.advanceTimersByTimeAsync(500);
			await expect(promise).resolves.toBe(false);
		});
	});

	it("signal.abort → 立即结算（reason=aborted），且 settle 后移除监听不泄漏", async () => {
		const { host, resolved } = makeHost();
		const controller = new AbortController();
		const promise = host.ask("select", { title: "t", options: ["x"] }, { signal: controller.signal });
		controller.abort();
		await expect(promise).resolves.toBeUndefined();
		expect(resolved[0]?.reason).toBe("aborted");
		// abort 后再 abort 无副作用（listener 已移除）
		expect(() => controller.abort()).not.toThrow();
	});

	it("ask 时 signal 已中止：不 dispatch、立即取消", async () => {
		const { host, requests, resolved } = makeHost();
		const controller = new AbortController();
		controller.abort();
		const promise = host.ask("select", { title: "t", options: ["x"] }, { signal: controller.signal });
		await expect(promise).resolves.toBeUndefined();
		expect(requests).toHaveLength(0);
		expect(resolved).toHaveLength(1);
	});

	it("竞态幂等：respond 与 timeout 只取第一个", async () => {
		await withFakeTimers(async () => {
			const { host, requests, resolved } = makeHost();
			const promise = host.ask("input", { title: "t" }, { timeout: 100 });
			host.respond(requests[0].id, { value: "答案" });
			await vi.advanceTimersByTimeAsync(200);
			await expect(promise).resolves.toBe("答案"); // 用户应答先到，超时不覆盖
			expect(resolved).toHaveLength(1);
			expect(resolved[0]?.reason).toBe("answered");
			// 未知 requestId 的 respond 静默忽略
			expect(() => host.respond("dlg-s1-999", { cancelled: true })).not.toThrow();
		});
	});

	it("input 空串如实提交（不与取消混淆）", async () => {
		const { host, requests } = makeHost();
		const promise = host.ask("input", { title: "分支名" });
		host.respond(requests[0].id, { value: "" });
		await expect(promise).resolves.toBe("");
	});

	it("dispose：全部 pending 按 sessionClosed 结算，后续 respond 无效", async () => {
		const { host, resolved } = makeHost();
		const p1 = host.ask("select", { title: "a", options: ["1"] });
		const p2 = host.ask("confirm", { title: "b" });
		host.dispose();
		await expect(p1).resolves.toBeUndefined();
		await expect(p2).resolves.toBe(false);
		expect(resolved).toHaveLength(2);
		expect(resolved.every((r) => r.reason === "sessionClosed")).toBe(true);
	});
});
