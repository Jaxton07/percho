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
	it("invalid local input does not consume a sequence; reads and old-instance checks do not submit mutations", async () => {
		const f = fixture();
		try {
			await f.client.attach("desktop");
			await expect(f.client.invoke("prompt", { sessionId: "same", text: 123 })).rejects.toThrow("Invalid");
			expect(await f.client.queryReceipt({ instanceId: "old", epoch: 1, sequence: 1 })).toEqual({
				state: "unknown",
			});
			const pending = f.client.invoke("prompt", { sessionId: "same", text: "write" });
			await vi.waitFor(() => expect(f.requests.at(-1)?.type).toBe("invoke"));
			const request = f.requests.at(-1);
			if (request?.type !== "invoke") throw new Error("Missing invocation");
			expect(request.mutationSeq).toBe(1);
			f.write({ type: "result", id: request.id, result: null });
			await pending;
			expect(f.requests.filter((request) => request.type === "invoke")).toHaveLength(1);
		} finally {
			f.client.close();
		}
	});
	it("binds calls and heartbeats to the attached instance and epoch; events remain asynchronous", async () => {
		const f = fixture();
		try {
			const attachment = (await f.client.attach("desktop")) as RuntimeAttachment;
			const pending = f.client.invoke("getStats", { sessionId: "same" });
			void pending.catch(() => {}); // Cleanup on an assertion failure must not leave an unhandled request.
			await vi.waitFor(() => expect(f.requests.at(-1)?.type).toBe("invoke"));
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
		await vi.waitFor(() => expect(f.requests.at(-1)?.type).toBe("invoke"));
		f.client.close();
		await failed;
		expect(f.requests.filter((request) => request.type === "invoke")).toHaveLength(1);
	});
});

it("an idle half-open attachment times out without waiting for a new business call", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const f = fixture();
	try {
		await f.client.attach("desktop");
		await vi.advanceTimersByTimeAsync(20_000);
		// An unrelated instance cannot keep an old attachment apparently healthy.
		f.write({ type: "ping", nonce: "old", instanceId: "other", epoch: 4 });
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(f.client.invoke("getLoadedSessions")).rejects.toThrow(/closed/);
	} finally {
		f.client.close();
		vi.useRealTimers();
	}
});
it("current daemon heartbeats keep an otherwise idle connection usable", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	const f = fixture();
	try {
		await f.client.attach("desktop");
		for (let i = 0; i < 8; i++) {
			await vi.advanceTimersByTimeAsync(5000);
			f.write({ type: "ping", nonce: String(i), instanceId: "instance", epoch: 4 });
			await vi.advanceTimersByTimeAsync(0);
		}
		const pending = f.client.invoke("getLoadedSessions");
		void pending.catch(() => {});
		for (let turn = 0; turn < 32 && !f.requests.some((item) => item.type === "invoke"); turn++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		const request = f.requests.find((item) => item.type === "invoke");
		if (request?.type !== "invoke") throw Error("Missing request");
		f.write({ type: "result", id: request.id, result: [] });
		await expect(pending).resolves.toEqual([]);
	} finally {
		f.client.close();
		vi.useRealTimers();
	}
});
