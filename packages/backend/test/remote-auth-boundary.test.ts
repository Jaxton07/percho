import { describe, expect, it, vi } from "vitest";
import { createExecutionHandlers } from "../src/execution-handlers";
import type { PiBackend } from "../src/pi-backend";
import { remoteAuthGuide } from "../src/runtime/ssh";

describe("remote authentication boundary", () => {
	it("rejects interactive login before starting any provider or callback, while retaining the local flow", async () => {
		const startLogin = vi.fn(async () => ({ ok: true }));
		const backend = { login: { startLogin } } as unknown as PiBackend;
		expect(() =>
			createExecutionHandlers(backend, { allowInteractiveAuth: false }).startProviderLogin({
				loginId: "login",
				providerId: "provider",
			}),
		).toThrow("maintenance");
		expect(startLogin).not.toHaveBeenCalled();
		await createExecutionHandlers(backend).startProviderLogin({ loginId: "local", providerId: "provider" });
		expect(startLogin).toHaveBeenCalledWith("local", "provider");
	});
	it("uses the original installed release and quotes the remote executable literally", () => {
		const guide = remoteAuthGuide("company-dev", "/home/a'b/node", "0.6.5-linux-arm64");
		expect(guide.sshCommand).toContain("-oStrictHostKeyChecking=yes");
		expect(guide.authCommand).toContain("'/home/a'\\''b/node'");
		expect(guide.authCommand).toContain('/0.6.5-linux-arm64/entry.mjs" auth');
		expect(() => remoteAuthGuide("dev", "/bin/node", "../other")).toThrow();
	});
});
