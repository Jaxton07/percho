import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelService } from "../src/tools/channels/service";
import { makeChannelTools } from "../src/tools/channels/tools";

let dir = "";
let service: ChannelService | undefined;
afterEach(async () => {
	await service?.close();
	vi.useRealTimers();
	service = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
});
test("close drains accepted work before closing the worker database", async () => {
	const base = resolve("../../.local/tmp/channels-tools");
	await mkdir(base, { recursive: true });
	dir = await mkdtemp(join(base, "close-"));
	service = new ChannelService({ projectRoot: dir, agentDir: dir });
	const pending = service.manage({ sessionId: "alice" }, { action: "create", topic: "work" });
	const closing = service.close();
	await expect(pending).resolves.toMatchObject({ channels: expect.any(Array) });
	await closing;
	await expect(service.snapshot("alice")).rejects.toThrow("closed");
	service = new ChannelService({ projectRoot: dir, agentDir: dir });
	await expect(service.snapshot("alice")).resolves.toEqual([{ topic: "work", unread: 0 }]);
});
test("idle workers close and reopen without losing messages, read positions or receipts", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const base = resolve("../../.local/tmp/channels-tools");
	await mkdir(base, { recursive: true });
	dir = await mkdtemp(join(base, "idle-"));
	service = new ChannelService({ projectRoot: dir, agentDir: dir });
	const state = service as unknown as { worker?: Worker; idleClosing?: Promise<void> };
	const creating = service.manage({ sessionId: "alice" }, { action: "create", topic: "work" });
	const original = state.worker;
	vi.advanceTimersByTime(30_000);
	expect(state.worker).toBe(original);
	await creating;
	const subscribing = service.manage({ sessionId: "bob" }, { action: "subscribe", topic: "work" });
	vi.advanceTimersByTime(30_000);
	expect(state.worker).toBe(original);
	await subscribing;
	const posted = await service.post({ sessionId: "alice" }, "work", "hello", "post-1");
	const read = await service.read({ sessionId: "bob" }, { topic: "work" }, "read-1");
	vi.advanceTimersByTime(30_000);
	expect(state.idleClosing).toBeDefined();
	const reopened = service.snapshot("bob");
	await expect(reopened).resolves.toEqual([{ topic: "work", unread: 0 }]);
	expect(state.worker).not.toBe(original);
	const receipt = await service.post({ sessionId: "alice" }, "work", "hello", "post-1");
	expect(receipt).toEqual(posted);
	await expect(service.read({ sessionId: "bob" }, { topic: "work" }, "read-1")).resolves.toEqual(read);
	await expect(service.snapshot("bob")).resolves.toEqual([{ topic: "work", unread: 0 }]);
	vi.advanceTimersByTime(30_000);
	const accepted = service.snapshot("bob");
	const closing = service.close();
	expect(service.close()).toBe(closing);
	await expect(accepted).resolves.toEqual([{ topic: "work", unread: 0 }]);
	await closing;
});

test("unexpected worker exit permits a new worker", async () => {
	const base = resolve("../../.local/tmp/channels-tools");
	await mkdir(base, { recursive: true });
	dir = await mkdtemp(join(base, "exit-"));
	service = new ChannelService({ projectRoot: dir, agentDir: dir });
	await service.manage({ sessionId: "alice" }, { action: "create", topic: "work" });
	const state = service as unknown as { worker?: Worker };
	const original = state.worker;
	if (!original) throw new Error("Expected a worker");
	await original.terminate();
	await expect(service.snapshot("alice")).resolves.toEqual([{ topic: "work", unread: 0 }]);
	expect(state.worker).not.toBe(original);
});

test("real tools share a worker and preserve unread and call receipts", async () => {
	const base = resolve("../../.local/tmp/channels-tools");
	await mkdir(base, { recursive: true });
	dir = await mkdtemp(join(base, "case-"));
	service = new ChannelService({ projectRoot: dir, agentDir: dir });
	let id = "alice";
	const tools = makeChannelTools({ service: async () => service!, actor: () => ({ sessionId: id }) });
	const call = async (name: string, callId: string, params: object) => {
		const tool = tools.find((item) => item.name === name)!;
		return tool.execute(callId, params, undefined, undefined, {} as never);
	};
	expect((await call("channel_manage", "1", { action: "create", topic: "work" })).details).toMatchObject({
		channels: expect.any(Array),
	});
	id = "bob";
	expect((await call("channel_manage", "2", { action: "subscribe", topic: "work" })).isError).not.toBe(true);
	id = "alice";
	expect((await call("channel_post", "3", { topic: "work", message: "hello" })).isError).not.toBe(true);
	expect((await call("channel_post", "3", { topic: "work", message: "hello" })).isError).not.toBe(true);
	expect((await call("channel_post", "4", { topic: "work", message: "x", closed: true })).isError).toBe(true);
	id = "bob";
	expect(await service.snapshot(id)).toEqual([{ topic: "work", unread: 1 }]);
	const read = await call("channel_read", "5", { topic: "work" });
	expect(read.isError).not.toBe(true);
	expect(read.content[0]).toMatchObject({ text: expect.stringContaining("hello") });
	expect(await service.snapshot(id)).toEqual([{ topic: "work", unread: 0 }]);
});
