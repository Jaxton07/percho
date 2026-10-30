import { APP_CHANNELS, environmentInvocation, LOCAL_ENVIRONMENT } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (_event: unknown, args?: unknown) => unknown) =>
			fixture.handlers.set(channel, handler),
	},
}));

import { environmentRouter } from "../environment-router";
import { registerInvokeHandlers } from "./invoke";

describe("public IPC target boundary", () => {
	it("preserves Electron provenance for native handlers without adding it to the payload", () => {
		const handler = vi.fn();
		registerInvokeHandlers({ menu: APP_CHANNELS.showComposerEditMenu }, { menu: handler });
		const native = fixture.handlers.get(APP_CHANNELS.showComposerEditMenu.channel);
		const event = { sender: {}, senderFrame: {} };
		const args = { token: "editor", x: 10, y: 20 };
		native?.(event, args);
		expect(handler).toHaveBeenCalledWith(args, event);
	});
	it("rejects implicit execution and mismatched environments; native methods remain desktop-owned", async () => {
		const branch = vi.fn(async () => "local-main");
		const pick = vi.fn(async () => "/local");
		registerInvokeHandlers(
			{ getGitBranch: APP_CHANNELS.getGitBranch, pickDirectory: APP_CHANNELS.pickDirectory },
			{ getGitBranch: branch, pickDirectory: pick },
		);
		const execute = fixture.handlers.get(APP_CHANNELS.getGitBranch.channel);
		const native = fixture.handlers.get(APP_CHANNELS.pickDirectory.channel);
		if (!execute || !native) throw new Error("IPC not registered");
		expect(() => execute({}, { cwd: "/same" })).toThrow("Invalid environment invocation");
		expect(branch).not.toHaveBeenCalled();
		expect(await execute({}, environmentInvocation(LOCAL_ENVIRONMENT, { cwd: "/same" }))).toBe("local-main");
		const remote = { kind: "ssh" as const, connectionId: "company", environmentId: "data" };
		const invoke = vi.fn(async () => "remote-main");
		const detach = environmentRouter.attach(remote, { invoke });
		try {
			expect(await execute({}, environmentInvocation(remote, { cwd: "/same" }))).toBe("remote-main");
			expect(invoke).toHaveBeenCalledWith("getGitBranch", { cwd: "/same" });
			expect(() =>
				execute({}, environmentInvocation({ ...remote, environmentId: "replacement" }, { cwd: "/same" })),
			).toThrow("identity has changed");
			expect(await native({})).toBe("/local");
			expect(() => native({}, environmentInvocation(remote, undefined))).toThrow("not an execution method");
			expect(pick).toHaveBeenCalledTimes(1);
		} finally {
			detach();
		}
	});
});
