import { Duplex, PassThrough } from "node:stream";
import { REMOTE_PROTOCOL_VERSION, type RuntimeAttachment, type RuntimeRequest } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../src/runtime/client";
import { readRuntimeFrames } from "../src/runtime/frames";

function fixture() {
	const input = new PassThrough();
	const output = new PassThrough();
	const requests: RuntimeRequest[] = [];
	const write = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`);
	const info = {
		protocol: REMOTE_PROTOCOL_VERSION,
		runtimeVersion: "0.1.0",
		environmentId: "data",
		instanceId: "instance",
		canonicalAgentDir: "/private/agent",
		uid: 1,
		pid: 2,
		startedAt: 1,
	};
	output.on(
		"data",
		readRuntimeFrames(
			(value) => {
				const request = value as RuntimeRequest;
				requests.push(request);
				if (request.type === "attach") write({ type: "result", id: request.id, result: { info, epoch: 4 } });
			},
			(error) => {
				throw error;
			},
		),
	);
	const events = vi.fn();
	const client = RuntimeClient.fromStream(Duplex.from({ readable: input, writable: output }), events);
	return { client, requests, write, events };
}

describe("runtime client transport ownership", () => {
	it("binds calls and heartbeats to the attached instance and epoch; events remain asynchronous", async () => {
		const f = fixture();
		try {
			const attachment = (await f.client.attach("desktop")) as RuntimeAttachment;
			const pending = f.client.invoke("getStats", { sessionId: "same" });
			void pending.catch(() => {}); // Cleanup on an assertion failure must not leave an unhandled request.
			const request = f.requests.at(-1);
			if (request?.type !== "invoke") throw new Error("Missing invocation");
			expect(request).toMatchObject({
				instanceId: attachment.info.instanceId,
				epoch: 4,
				method: "getStats",
				args: { sessionId: "same" },
			});
			f.write({ type: "event", method: "onEvent", payload: { sessionId: "same" } });
			await vi.waitFor(() => expect(f.events).toHaveBeenCalledWith("onEvent", { sessionId: "same" }));
			f.write({ type: "ping", nonce: "original", instanceId: "instance", epoch: 4 });
			await vi.waitFor(() =>
				expect(f.requests.at(-1)).toEqual({
					type: "pong",
					nonce: "original",
					instanceId: "instance",
					epoch: 4,
				}),
			);
			f.write({ type: "ping", nonce: "stale", instanceId: "old", epoch: 3 });
			f.write({ type: "event", method: "onEvent", payload: { sessionId: "barrier" } });
			await vi.waitFor(() => expect(f.events).toHaveBeenCalledWith("onEvent", { sessionId: "barrier" }));
			expect(f.requests.filter((request) => request.type === "pong")).toHaveLength(1);
			f.write({ type: "result", id: request.id, result: { tokens: 1 } });
			expect(await pending).toEqual({ tokens: 1 });
		} finally {
			f.client.close();
		}
	});
	it("a transport loss rejects an in-flight operation as unknown without sending it again", async () => {
		const f = fixture();
		await f.client.attach("desktop");
		const pending = f.client.invoke("prompt", { sessionId: "same", text: "write" });
		const failed = expect(pending).rejects.toThrow("outcome may be unknown");
		f.client.close();
		await failed;
		expect(f.requests.filter((request) => request.type === "invoke")).toHaveLength(1);
	});
});
