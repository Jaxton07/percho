import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SshPreflight } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { checkSshRequirements, runSsh, shellQuote, sshFailureKind } from "../src/runtime/ssh-preflight";

describe("runSsh child lifecycle", () => {
	it.each(["error", "abort"])("waits for close after %s and preserves the error", async (kind) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		});
		const controller = new AbortController();
		const error = Object.assign(new Error(kind), { name: kind === "abort" ? "AbortError" : "Error" });
		spawn.mockImplementationOnce((_file, _args, options) => {
			options.signal.addEventListener("abort", () => child.emit("error", error));
			return child;
		});
		let settled = false;
		const result = runSsh([], controller.signal).catch((err: unknown) => {
			settled = true;
			return err;
		});
		if (kind === "abort") controller.abort();
		else child.emit("error", error);
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		child.emit("close", null);
		expect(await result).toBe(error);
	});
	it("escalates termination to SIGKILL while still waiting for close", async () => {
		vi.useFakeTimers();
		try {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			spawn.mockReturnValueOnce(child);
			const result = runSsh([], new AbortController().signal, 10).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(1010);
			expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
			child.emit("close", null);
			expect(await result).toMatchObject({ message: "SSH connection timed out" });
		} finally {
			vi.useRealTimers();
		}
	});
});

const probe: SshPreflight = {
	alias: "dev",
	target: { hostname: "host", user: "user", port: "22" },
	uid: 1000,
	home: "/home/user",
	node: "/usr/bin/node",
	nodeVersion: "22.19.0",
	platform: "linux",
	arch: "arm64",
	glibc: "2.35",
	commands: { sh: true, tar: true, sha256sum: true, flock: true, setsid: true },
	installed: false,
};
describe("SSH preflight requirements", () => {
	it("reports missing installation independently from platform readiness", () => {
		expect(() => checkSshRequirements(probe)).not.toThrow();
		for (const nodeVersion of ["22.19.0", "24.22.1", "26.12.1"])
			expect(() => checkSshRequirements({ ...probe, nodeVersion })).not.toThrow();
		for (const change of [
			{ nodeVersion: "20.19.0" },
			{ nodeVersion: "22.18.0" },
			{ nodeVersion: "22.19.0-rc.1" },
			{ nodeVersion: "garbage" },
			{ glibc: "" },
			{ platform: "darwin" },
			{ arch: "riscv64" },
			{ commands: {} },
		])
			expect(() => checkSshRequirements({ ...probe, ...change })).toThrow();
	});
	it("never treats authentication, changed identity, unknown host or occupancy as retryable networking", () => {
		for (const [message, kind] of [
			["Permission denied (publickey)", "authentication"],
			["Host key verification failed", "hostKey"],
			["Remote identity changed", "identity"],
			["incompatible runtime", "incompatible"],
			["Runtime already controlled by other", "busy"],
			["NODE_REQUIRED", "requirements"],
			["Connection reset by peer", "network"],
		])
			expect(sshFailureKind(new Error(message))).toBe(kind);
	});
	it("quotes remote program paths including shell metacharacters literally", () => {
		expect(shellQuote("/home/a'b/$(touch proof)/node")).toBe("'/home/a'\\''b/$(touch proof)/node'");
	});
});
