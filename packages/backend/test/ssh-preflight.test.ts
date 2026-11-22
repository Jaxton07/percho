import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import type { SshPreflight } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import {
	checkSshRequirements,
	preflightSsh,
	runSsh,
	shellQuote,
	sshFailureKind,
} from "../src/runtime/ssh-preflight";

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

describe("preflightSsh owner lock evidence", () => {
	async function runProbe(options: {
		lock?: "safe" | "missing" | "symlink" | "public" | "foreign";
		flock?: number | null;
		invalid?: unknown;
		unsafeParent?: boolean;
	}) {
		const calls: string[] = [];
		const flock = vi.fn(() => ({ status: options.flock ?? (options.flock === null ? null : 0) }));
		const stat = {
			isFile: () => true,
			isSymbolicLink: () => options.lock === "symlink",
			uid: options.lock === "foreign" ? 1001 : 1000,
			mode: options.lock === "public" ? 0o644 : 0o600,
			dev: 1,
			ino: 2,
		};
		const fs = {
			constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
			realpathSync: (p: string) => p,
			existsSync: () => false,
			readFileSync: () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			},
			lstatSync: (p: string) => {
				if (!p.endsWith("owner.lock")) {
					calls.push("parent");
					return {
						isDirectory: () => true,
						isSymbolicLink: () => false,
						uid: 1000,
						mode: options.unsafeParent && p.endsWith("/run") ? 0o777 : 0o700,
					};
				}
				calls.push("lstat");
				if (!options.lock || options.lock === "missing") throw new Error("missing");
				return stat;
			},
			openSync: (_p: string, flags: number) => {
				calls.push(`open:${flags}`);
				return 42;
			},
			fstatSync: () => stat,
			closeSync: () => {
				calls.push("close");
			},
		};
		let remoteOutput = "";
		spawn.mockImplementation((_file, args: string[]) => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(async () => {
				if (args[0] === "-G") child.stdout.write("hostname host\nuser user\nport 22\n");
				else {
					const command = args.at(-1) ?? "";
					const quoted = command.slice(command.indexOf("exec node -e ") + "exec node -e ".length);
					const script = quoted.slice(1, -1).replaceAll("'\\''", "'");
					await new Promise<void>((resolve, reject) => {
						const modules: Record<string, unknown> = {
							"node:fs": fs,
							"node:os": { homedir: () => "/home/user" },
							"node:path": path,
							"node:crypto": crypto,
							"node:net": {},
							"node:child_process": {
								spawnSync: (file: string, args: string[], opts: unknown) =>
									file === "sh" ? { status: 0 } : flock(file, args, opts),
							},
						};
						runInNewContext(script, {
							require: (name: string) => modules[name],
							process: {
								getuid: () => 1000,
								execPath: "/usr/bin/node",
								versions: { node: "22.19.0" },
								platform: "linux",
								arch: "x64",
								report: { getReport: () => ({ header: { glibcVersionRuntime: "2.35" } }) },
							},
							console: {
								log: (s: string) => {
									remoteOutput = s;
									resolve();
								},
								error: reject,
							},
							setTimeout,
							clearTimeout,
						});
					});
					const result = JSON.parse(remoteOutput);
					if ("invalid" in options) result.ownerReleased = options.invalid;
					child.stdout.write(JSON.stringify(result));
				}
				child.emit("close", 0);
			});
			return child;
		});
		const result = preflightSsh("dev", new AbortController().signal);
		return { result, calls, flock };
	}

	it.each([
		["occupied", { lock: "safe", flock: 75 }, false],
		["available", { lock: "safe", flock: 0 }, true],
		["missing", { lock: "missing" }, false],
		["symlink", { lock: "symlink" }, false],
		["public", { lock: "public" }, false],
		["foreign", { lock: "foreign" }, false],
		["timeout", { lock: "safe", flock: null }, false],
	] as const)("reports stopped with %s lock evidence", async (_name, options, expected) => {
		const { result, calls, flock } = await runProbe(options);
		expect(await result).toMatchObject({ serviceState: "stopped", ownerReleased: expected });
		if (options.lock === "safe") {
			expect(calls).toEqual(["lstat", "parent", "parent", `open:${0x20000}`, "close"]);
			expect(flock).toHaveBeenCalledWith(
				"flock",
				["-n", "-E", "75", "3"],
				expect.objectContaining({ stdio: ["ignore", "ignore", "ignore", 42], timeout: expect.any(Number) }),
			);
		} else expect(calls).toEqual(["lstat"]);
	});
	it("does not claim owner release through an unsafe private directory", async () => {
		const { result, calls, flock } = await runProbe({ lock: "safe", flock: 0, unsafeParent: true });
		expect(await result).toMatchObject({ serviceState: "stopped", ownerReleased: false });
		expect(calls).not.toContain(`open:${0x20000}`);
		expect(flock).not.toHaveBeenCalled();
	});
	it("rejects non-boolean ownerReleased JSON", async () => {
		const { result } = await runProbe({ invalid: "true" });
		await expect(result).rejects.toThrow("Invalid remote preflight response");
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
