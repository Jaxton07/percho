import {
	LOCAL_ENVIRONMENT,
	type SessionEvent,
	type SessionMeta,
	type TaskNotificationTarget,
} from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { TaskNotificationObserver } from "./task-notification-observer";

const meta = { sessionId: "s", sessionFile: "/fixture/s.jsonl" } as SessionMeta;
const ev = (value: object) => value as SessionEvent;
const start = ev({ type: "agent_start" });
const success = ev({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
const end = ev({ type: "agent_end", messages: [], willRetry: false });
const settled = ev({ type: "agent_settled", aborted: false });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup() {
	const send = vi.fn(async (_kind: string, _target: TaskNotificationTarget, _valid: () => boolean) => {});
	const state = { enabled: true, background: true };
	const observer = new TaskNotificationObserver({
		enabled: () => state.enabled,
		background: () => state.background,
		ready: async () => {},
		send,
	});
	let sequence = 0;
	const emit = (event: SessionEvent, getMeta = () => meta) =>
		observer.observe(LOCAL_ENVIRONMENT, { sessionId: "s", event, sequence: ++sequence }, getMeta);
	return { observer, send, state, emit };
}
describe("task notification observation", () => {
	it("does not resend failed submissions and abandons pending results on shutdown", async () => {
		const { observer, emit, send } = setup();
		send.mockRejectedValueOnce(new Error("fixture unavailable"));
		for (const event of [start, success, end, settled]) emit(event);
		await flush();
		expect(send).toHaveBeenCalledOnce();
		emit(settled);
		await flush();
		expect(send).toHaveBeenCalledOnce();
		let finish: (meta: SessionMeta) => void = () => {};
		observer.observe(
			LOCAL_ENVIRONMENT,
			{ sessionId: "pending", event: start },
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await flush();
		for (const event of [success, end, settled])
			observer.observe(LOCAL_ENVIRONMENT, { sessionId: "pending", event }, () => meta);
		observer.stop();
		finish(meta);
		for (const event of [start, success, end, settled]) emit(event);
		await flush();
		expect(send).toHaveBeenCalledOnce();
	});
	it("isolates the same bare session id in different environments and invalidates old epochs", async () => {
		const { observer, send } = setup();
		const remote = { kind: "ssh", connectionId: "c", environmentId: "e" } as const;
		for (const environment of [LOCAL_ENVIRONMENT, remote])
			for (const [index, event] of [start, success, end, settled].entries())
				observer.observe(environment, { sessionId: "s", event, sequence: index + 1 }, () => meta);
		await flush();
		expect(send).toHaveBeenCalledTimes(2);
		const localValid = send.mock.calls.find((x) => x[1].environment.kind === "local")?.[2];
		const remoteValid = send.mock.calls.find((x) => x[1].environment.kind === "ssh")?.[2];
		observer.detach(remote);
		expect(remoteValid?.()).toBe(false);
		expect(localValid?.()).toBe(true);
		for (const [index, event] of [success, end, settled].entries())
			observer.observe(remote, { sessionId: "s", event, sequence: index + 1 }, () => meta);
		await flush();
		expect(send).toHaveBeenCalledTimes(2);
	});
	it("invalidates delayed remote qualifications on disconnect and ignores repeated sequences", async () => {
		const { observer, send } = setup();
		const remote = { kind: "ssh", connectionId: "c", environmentId: "e" } as const;
		let finish: (meta: SessionMeta) => void = () => {};
		observer.observe(
			remote,
			{ sessionId: "s", event: start, sequence: 1 },
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await flush();
		for (const [i, event] of [success, end, settled].entries())
			observer.observe(remote, { sessionId: "s", event, sequence: i + 2 }, () => meta);
		observer.detach(remote);
		finish(meta);
		await flush();
		expect(send).not.toHaveBeenCalled();
		for (const [i, event] of [start, success, end, settled].entries())
			observer.observe(remote, { sessionId: "s", event, sequence: i + 1 }, () => meta);
		await flush();
		expect(send).toHaveBeenCalledOnce();
		for (const [i, event] of [start, success, end, settled].entries())
			observer.observe(remote, { sessionId: "s", event, sequence: i + 1 }, () => meta);
		await flush();
		expect(send).toHaveBeenCalledOnce();
	});
	it("requires a real start and whole-run result; duplicate cleanup cannot notify again", async () => {
		const { emit, send } = setup();
		emit(success);
		emit(end);
		emit(settled);
		await flush();
		expect(send).not.toHaveBeenCalled();
		emit(start);
		emit(success);
		expect(send).not.toHaveBeenCalled();
		emit(end);
		emit(settled);
		emit(settled);
		await flush();
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]?.[0]).toBe("completed");
	});
	it.each(["enabled", "background"] as const)("consumes suppressed results when %s is false", async (key) => {
		const { emit, send, state } = setup();
		emit(start);
		emit(success);
		emit(end);
		state[key] = false;
		emit(settled);
		state[key] = true;
		await flush();
		expect(send).not.toHaveBeenCalled();
		emit(settled);
		await flush();
		expect(send).not.toHaveBeenCalled();
	});
	it("keeps a completed target valid across GC, invalidates it only on deletion", async () => {
		const { emit, observer, send } = setup();
		emit(start);
		emit(success);
		emit(end);
		emit(settled);
		await flush();
		const valid = send.mock.calls[0]?.[2];
		observer.unload(LOCAL_ENVIRONMENT, "s");
		expect(valid?.()).toBe(true);
		observer.delete(LOCAL_ENVIRONMENT, "s");
		expect(valid?.()).toBe(false);
	});
	it("drops readonly runs and checks background again after delayed metadata", async () => {
		const { observer, send, state } = setup();
		let finish: (meta: SessionMeta) => void = () => {};
		observer.observe(
			LOCAL_ENVIRONMENT,
			{ sessionId: "s", event: start },
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await flush();
		for (const event of [success, end, settled])
			observer.observe(LOCAL_ENVIRONMENT, { sessionId: "s", event }, () => meta);
		state.background = false;
		finish(meta);
		await flush();
		expect(send).not.toHaveBeenCalled();
		state.background = true;
		for (const event of [start, success, end, settled])
			observer.observe(LOCAL_ENVIRONMENT, { sessionId: "s", event }, () => ({ ...meta, readOnly: true }));
		await flush();
		expect(send).not.toHaveBeenCalled();
	});
	it("does not overwrite a settled run waiting for metadata with the next run", async () => {
		const { observer, send } = setup();
		let finish: (meta: SessionMeta) => void = () => {};
		observer.observe(
			LOCAL_ENVIRONMENT,
			{ sessionId: "s", event: start },
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await flush();
		for (const event of [success, end, settled])
			observer.observe(LOCAL_ENVIRONMENT, { sessionId: "s", event }, () => meta);
		observer.observe(LOCAL_ENVIRONMENT, { sessionId: "s", event: start }, () => meta);
		finish(meta);
		await flush();
		expect(send).toHaveBeenCalledOnce();
	});
});
