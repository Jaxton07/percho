import { describe, expect, it } from "vitest";
import { PermissionGate } from "../src/permissions";

function makeGate() {
	const requests: string[] = [];
	const gate = new PermissionGate((req) => requests.push(req.id));
	gate.bindSession("s1");
	return { gate, requests };
}

describe("PermissionGate", () => {
	it("发出 permission_request 并等待应答", async () => {
		const { gate, requests } = makeGate();

		const promise = gate.confirm("运行 bash?", "rm -rf /");
		expect(requests).toHaveLength(1);

		gate.respond(requests[0], "allow");
		await expect(promise).resolves.toBe(true);
	});

	it("deny 返回 false", async () => {
		const { gate, requests } = makeGate();
		const promise = gate.confirm("x", "y");
		gate.respond(requests[0], "deny");
		await expect(promise).resolves.toBe(false);
	});

	it("allowAlways 记住 title，后续自动通过", async () => {
		const { gate, requests } = makeGate();

		const first = gate.confirm("bash", "cmd");
		gate.respond(requests[0], "allowAlways");
		await expect(first).resolves.toBe(true);

		// 同一 title 直接通过，不再产生请求
		await expect(gate.confirm("bash", "cmd2")).resolves.toBe(true);
		expect(requests).toHaveLength(1);

		// 不同 title 仍需确认
		const other = gate.confirm("edit", "file");
		expect(requests).toHaveLength(2);
		gate.respond(requests[1], "allow");
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
