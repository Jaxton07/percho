import type { SshPreflight } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { checkSshRequirements, shellQuote, sshFailureKind } from "../src/runtime/ssh-preflight";

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
