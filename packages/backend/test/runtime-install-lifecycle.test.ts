import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SshPreflight } from "@percho/shared";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), preflight: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ createReadStream: () => new PassThrough() }));
vi.mock("node:stream/promises", () => ({ pipeline: () => new Promise(() => {}) }));
vi.mock("../src/runtime/ssh-preflight", () => ({
	preflightSsh: mocks.preflight,
	checkSshRequirements: () => {},
	shellQuote: (value: string) => value,
}));

import { installSshRuntime } from "../src/runtime/install";

it("waits for the installation child to close after an error", async () => {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		kill: vi.fn(),
	});
	mocks.spawn.mockReturnValue(child);
	const probe = { alias: "host", serviceState: "stopped" } as SshPreflight;
	mocks.preflight.mockResolvedValue(probe);
	const error = new Error("installation failed");
	let settled = false;
	const result = installSshRuntime(
		probe,
		"unused",
		{
			releaseId: "v1",
			arch: "x64",
			bytes: 1,
			sha256: "hash",
			protocol: 1,
		},
		new AbortController().signal,
	).catch((cause: unknown) => {
		settled = true;
		return cause;
	});
	await new Promise((resolve) => setImmediate(resolve));
	child.emit("error", error);
	await new Promise((resolve) => setImmediate(resolve));
	expect(settled).toBe(false);
	expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	child.emit("close", null);
	expect(await result).toBe(error);
});
