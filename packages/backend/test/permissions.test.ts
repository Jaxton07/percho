import type { PermissionRequest } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { PermissionGate } from "../src/permissions/gate";

function makeGate(requests: PermissionRequest[] = []) {
	const gate = new PermissionGate((req) => requests.push(req));
	gate.bindSession("s1");
	return { gate, requests };
}

describe("PermissionGate", () => {
	it("发出 permission_request 并等待应答", async () => {
		const { gate, requests } = makeGate();

		const promise = gate.confirm("运行 bash?", "rm -rf /");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ title: "运行 bash?", kind: "other" });

		gate.respond(requests[0].id, "allow");
		await expect(promise).resolves.toBe(true);
	});

	it("meta 透传：kind/suggestDir 进请求载荷，getRequest 供持久化定位", async () => {
		const { gate, requests } = makeGate();
		const promise = gate.confirm("edit: /repo/*", "/repo/a.ts", {
			kind: "path",
			suggestDir: "/repo",
		});
		expect(requests[0]).toMatchObject({ kind: "path", suggestDir: "/repo" });
		expect(gate.getRequest(requests[0].id)).toEqual({
			title: "edit: /repo/*",
			meta: { kind: "path", suggestDir: "/repo" },
		});
		expect(gate.getSessionId()).toBe("s1");
		gate.respond(requests[0].id, "allow");
		await expect(promise).resolves.toBe(true);
		expect(gate.getRequest(requests[0].id)).toBeUndefined();
	});

	it("allowDir 应答视为允许（持久化由 PiBackend 在 respond 前处理）", async () => {
		const { gate, requests } = makeGate();
		const promise = gate.confirm("edit: /repo/*", "/repo/a.ts", { kind: "path", suggestDir: "/repo" });
		gate.respond(requests[0].id, "allowDir");
		await expect(promise).resolves.toBe(true);
	});

	it("deny 返回 false", async () => {
		const { gate, requests } = makeGate();
		const promise = gate.confirm("x", "y");
		gate.respond(requests[0].id, "deny");
		await expect(promise).resolves.toBe(false);
	});

	it("allowAlways 记住 title，后续自动通过", async () => {
		const { gate, requests } = makeGate();

		const first = gate.confirm("bash", "cmd");
		gate.respond(requests[0].id, "allowAlways");
		await expect(first).resolves.toBe(true);

		// 同一 title 直接通过，不再产生请求
		await expect(gate.confirm("bash", "cmd2")).resolves.toBe(true);
		expect(requests).toHaveLength(1);

		// 不同 title 仍需确认
		const other = gate.confirm("edit", "file");
		expect(requests).toHaveLength(2);
		gate.respond(requests[1].id, "allow");
		await expect(other).resolves.toBe(true);
	});

	it("dispose 时未决请求全部拒绝", async () => {
		const { gate, requests } = makeGate();
		const promise = gate.confirm("x", "y");
		gate.dispose();
		await expect(promise).resolves.toBe(false);
		expect(requests).toHaveLength(1);
	});
});
