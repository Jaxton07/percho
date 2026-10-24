import {
	CHANNEL_TABLE,
	type EnvironmentInvocation,
	type EnvironmentRef,
	environmentEntityId,
	environmentEntityKey,
	environmentInvocation,
	LOCAL_ENVIRONMENT,
} from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { createEnvironmentApi } from "../preload/environment-api";
import { EnvironmentRouter } from "./environment-router";

const remote: EnvironmentRef = { kind: "ssh", connectionId: "company", environmentId: "remote-data" };

describe("bound environment execution through the public API", () => {
	it("keeps local and remote calls fixed, including a completion after another call", async () => {
		const router = new EnvironmentRouter();
		let finish: (value: string) => void = () => {};
		const local = vi.fn(() => "local-result");
		const remoteInvoke = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		router.registerLocal(CHANNEL_TABLE.exportSession.channel, local);
		router.attach(remote, { invoke: remoteInvoke });
		const ipc = {
			invoke: async (channel: string, args: unknown) => router.invoke(channel, args as EnvironmentInvocation),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const remoteApi = createEnvironmentApi(ipc, remote);
		const localApi = createEnvironmentApi(ipc, LOCAL_ENVIRONMENT);
		const pending = remoteApi.exportSession({ sessionId: "same-id", format: "jsonl" });
		expect(await localApi.exportSession({ sessionId: "same-id", format: "jsonl" })).toBe("local-result");
		finish("remote-result");
		expect(await pending).toBe("remote-result");
		expect(local).toHaveBeenCalledExactlyOnceWith({ sessionId: "same-id", format: "jsonl" });
		expect(remoteInvoke).toHaveBeenCalledExactlyOnceWith("exportSession", {
			sessionId: "same-id",
			format: "jsonl",
		});
	});

	it("rejects unknown, changed, detached and native targets without falling back locally", async () => {
		const router = new EnvironmentRouter();
		const local = vi.fn(),
			execute = vi.fn();
		router.registerLocal(CHANNEL_TABLE.prompt.channel, local);
		expect(() => router.invoke(CHANNEL_TABLE.prompt.channel, environmentInvocation(remote, {}))).toThrow(
			"not attached",
		);
		const detach = router.attach(remote, { invoke: execute });
		const changed = { ...remote, environmentId: "replacement" } as EnvironmentRef;
		expect(() => router.invoke(CHANNEL_TABLE.prompt.channel, environmentInvocation(changed, {}))).toThrow(
			"identity",
		);
		expect(() => router.invoke("unknown:method", environmentInvocation(remote, {}))).toThrow(
			"not an execution",
		);
		for (const def of Object.values(CHANNEL_TABLE).filter((entry) => entry.scope === "desktop")) {
			expect(() => router.invoke(def.channel, environmentInvocation(remote, {}))).toThrow("not an execution");
		}
		detach();
		detach();
		expect(() => router.invoke(CHANNEL_TABLE.prompt.channel, environmentInvocation(remote, {}))).toThrow(
			"not attached",
		);
		expect(local).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("binds an immutable copy and does not allow replacing local or attaching a second remote", async () => {
		const router = new EnvironmentRouter();
		const mutable = { kind: "ssh" as const, connectionId: "company", environmentId: "original" };
		const calls: unknown[] = [];
		const api = createEnvironmentApi(
			{
				invoke: async (_channel, request) => {
					calls.push(request);
				},
				on: vi.fn(),
				removeListener: vi.fn(),
			},
			mutable,
		);
		mutable.environmentId = "replacement";
		await api.listAllSessions();
		expect(calls).toEqual([environmentInvocation({ ...mutable, environmentId: "original" }, undefined)]);
		expect("openPath" in api).toBe(false);
		expect("saveUiState" in api).toBe(false);
		expect(() => router.attach(LOCAL_ENVIRONMENT, { invoke: vi.fn() })).toThrow("cannot be replaced");
		router.attach(remote, { invoke: vi.fn() });
		expect(() => router.attach(remote, { invoke: vi.fn() })).toThrow("already attached");
	});

	it("isolates entity keys even for identical IDs, paths and delimiter-like characters", () => {
		for (const id of ["same-id", "/work/公司/a:b", '["local","id"]']) {
			const localKey = environmentEntityKey(LOCAL_ENVIRONMENT, id);
			const remoteKey = environmentEntityKey(remote, id);
			expect(localKey).not.toBe(remoteKey);
			expect(environmentEntityId(remote, remoteKey)).toBe(id);
			expect(() => environmentEntityId(LOCAL_ENVIRONMENT, remoteKey)).toThrow("different execution");
		}
	});

	it("only delivers matching events and removes the exact bound listener", () => {
		const listeners: Array<(event: unknown, payload: unknown, source?: unknown) => void> = [];
		const ipc = {
			invoke: vi.fn(),
			on: vi.fn((_channel: string, listener: (typeof listeners)[number]) => listeners.push(listener)),
			removeListener: vi.fn(),
		};
		const local = vi.fn(),
			foreign = vi.fn();
		const offLocal = createEnvironmentApi(ipc, LOCAL_ENVIRONMENT).onEvent(local);
		const offRemote = createEnvironmentApi(ipc, remote).onEvent(foreign);
		const payload = { sessionId: "same-id", event: { type: "agent_end", messages: [] } };
		for (const listener of listeners) {
			listener({}, payload);
			listener({}, payload, remote);
			listener({}, payload, { ...remote, environmentId: "replacement" });
			listener({}, payload, { kind: "invalid" });
		}
		expect(local).toHaveBeenCalledExactlyOnceWith(payload);
		expect(foreign).toHaveBeenCalledExactlyOnceWith(payload);
		offLocal();
		offRemote();
		expect(ipc.removeListener.mock.calls).toEqual(listeners.map((listener) => ["pi:event", listener]));
	});
});
