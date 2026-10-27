import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { executionContract, REMOTE_PROTOCOL_VERSION, type RuntimeInfo } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), info: undefined as unknown }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));

import { readRuntimeFrames } from "../src/runtime/frames";
import { SshRuntimeConnection, validateSshAlias } from "../src/runtime/ssh";

beforeEach(() => {
	fixture.info = {
		...executionContract(),
		protocol: REMOTE_PROTOCOL_VERSION,
		sdkVersion: "1.4.0",
		runtimeVersion: "0.1.0",
		environmentId: "data",
		instanceId: "instance",
		uid: 1000,
		pid: 123,
		startedAt: 1,
		canonicalAgentDir: "/远端/用户/agent",
	} satisfies RuntimeInfo;
	fixture.spawn.mockReset();
	fixture.spawn.mockImplementation((_file: string, args: string[]) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			stdin: new PassThrough(),
			kill: vi.fn(),
		});
		child.kill.mockImplementation(() => {
			child.emit("close", null);
			return true;
		});
		if (args.includes("-G"))
			queueMicrotask(() => {
				child.stdout.write("hostname server\nuser developer\nport 22\n");
				child.emit("close", 0);
			});
		else if (args.at(-1)?.includes("command -v node"))
			queueMicrotask(() => {
				child.stdout.write(
					JSON.stringify({
						uid: 1000,
						home: "/远端/用户",
						node: "/usr/bin/node",
						nodeVersion: "22.19.0",
						platform: "linux",
						arch: "arm64",
						glibc: "2.35",
						commands: { sh: true, tar: true, sha256sum: true, flock: true, setsid: true },
						installed: true,
					}),
				);
				child.emit("close", 0);
			});
		else if (args.at(-1)?.endsWith(" start"))
			queueMicrotask(() => {
				const bytes = Buffer.from(JSON.stringify(fixture.info));
				for (let offset = 0; offset < bytes.length; offset += 2)
					child.stdout.write(bytes.subarray(offset, offset + 2));
				child.emit("close", 0);
			});
		else
			child.stdin.on(
				"data",
				readRuntimeFrames(
					(value) => {
						const request = value as { type: string; id: string };
						child.stdout.write(
							`${JSON.stringify({ type: "result", id: request.id, result: request.type === "attach" ? { info: fixture.info, epoch: 1 } : { ok: true } })}\n`,
						);
					},
					(error) => {
						throw error;
					},
				),
			);
		return child;
	});
});

describe("SSH runtime boundary", () => {
	it.each([
		"-oProxyCommand=touch",
		"company;touch proof",
		"user@host",
		"host\nother",
		"*",
		"../host",
		"host\0",
	])("rejects destination expressions before spawning SSH: %s", async (alias) => {
		await expect(
			SshRuntimeConnection.connect(alias, {
				signal: new AbortController().signal,
				onEvent: () => {},
				onClose: () => {},
			}),
		).rejects.toThrow("concrete SSH Host alias");
		expect(fixture.spawn).not.toHaveBeenCalled();
	});
	it("rejects an incomplete event/method contract before opening a business bridge", async () => {
		const info = fixture.info as RuntimeInfo;
		fixture.info = { ...info, methods: info.methods.filter((method) => method !== "abort") };
		await expect(
			SshRuntimeConnection.connect("company", {
				signal: new AbortController().signal,
				onEvent: () => {},
				onClose: () => {},
			}),
		).rejects.toThrow("incompatible execution/event contract");
		expect(fixture.spawn).toHaveBeenCalledTimes(3);
	});
	it("preserves split UTF-8 identity, strictly verifies hosts and uses a bridge bound to that runtime", async () => {
		const connection = await SshRuntimeConnection.connect("company-dev", {
			signal: new AbortController().signal,
			onEvent: () => {},
			onClose: () => {},
		});
		try {
			expect(connection.info.canonicalAgentDir).toBe("/远端/用户/agent");
			expect(validateSshAlias("company-dev")).toBe("company-dev");
			const args = fixture.spawn.mock.calls[2]?.[1] as string[];
			expect(args).toContain("-oStrictHostKeyChecking=yes");
			expect(args).toContain("-oBatchMode=yes");
			expect(args).toContain("-oForwardAgent=no");
			expect(args).toContain("-T");
			expect(args).toContain("-oControlPath=none");
			expect(args.slice(-3, -1)).toEqual(["--", "company-dev"]);
			expect(await connection.invoke("getStats", { sessionId: "same" })).toEqual({ ok: true });
		} finally {
			connection.disconnect();
		}
	});
});
