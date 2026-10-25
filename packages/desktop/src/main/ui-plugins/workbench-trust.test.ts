import type { UiPluginsConfig } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { UiWorkbenchTrust } from "./workbench-trust";

function fixture() {
	let config: UiPluginsConfig = {
		enabled: true,
		plugins: { legacy: { enabled: true, trusted: true } },
		assignments: {},
	};
	const read = vi.fn(async () => config),
		confirm = vi.fn(async (_names: string[]) => true);
	const approve = vi.fn(async (names: string[]) => {
		for (const name of names)
			config.plugins[name] = {
				enabled: config.plugins[name]?.enabled ?? false,
				trusted: true,
				workbenchTrusted: true,
			};
	});
	return {
		gate: new UiWorkbenchTrust(read, approve, confirm),
		confirm,
		approve,
		set: (value: UiPluginsConfig) => {
			config = value;
		},
		config: () => config,
	};
}
describe("workbench-wide plugin trust", () => {
	it("does not ask for dormant plugins on a fresh renderer, but gates their later code delivery", async () => {
		const f = fixture();
		f.set({ enabled: false, plugins: { legacy: { enabled: false, trusted: true } }, assignments: {} });
		await f.gate.authorizeRemote();
		expect(f.confirm).not.toHaveBeenCalled();
		await f.gate.serve("legacy", async () => ({ code: "newly loaded" }));
		expect(f.confirm).toHaveBeenCalledWith(["legacy"]);
	});
	it("includes code already delivered even after the plugin is disabled and removed from config", async () => {
		const f = fixture();
		await f.gate.serve("legacy", async () => ({ code: "fixture" }));
		f.set({ enabled: false, plugins: {}, assignments: {} });
		await f.gate.authorizeRemote();
		expect(f.confirm).toHaveBeenCalledWith(["legacy"]);
		expect(f.config().enabled).toBe(false);
		expect(f.config().plugins.legacy?.enabled).toBe(false);
	});
	it("coalesces startup refusal, preserves local code access, and only reconsiders on explicit retry", async () => {
		const f = fixture();
		f.confirm.mockResolvedValue(false);
		await expect(f.gate.authorizeRemote()).rejects.toThrow("declined");
		await expect(f.gate.authorizeRemote()).rejects.toThrow("explicitly");
		expect(f.confirm).toHaveBeenCalledOnce();
		expect(f.approve).not.toHaveBeenCalled();
		await expect(f.gate.serve("legacy", async () => ({ code: "local-only" }))).resolves.toEqual({
			code: "local-only",
		});
		f.confirm.mockResolvedValue(true);
		f.gate.resetDecline();
		await f.gate.authorizeRemote();
		expect(f.confirm).toHaveBeenCalledTimes(2);
	});
	it("never delivers new plugin code into an already remote-capable renderer before approval", async () => {
		const f = fixture();
		f.set({ enabled: false, plugins: {}, assignments: {} });
		await f.gate.authorizeRemote();
		f.confirm.mockResolvedValue(false);
		const load = vi.fn(async () => ({ code: "must-not-execute" }));
		await expect(f.gate.serve("new-plugin", load)).rejects.toThrow("declined");
		expect(load).not.toHaveBeenCalled();
		f.confirm.mockResolvedValue(true);
		await f.gate.authorizeEnable("new-plugin");
		await f.gate.serve("new-plugin", load);
		expect(load).toHaveBeenCalledOnce();
	});
	it("orders a racing code delivery behind remote authorization and separately approves the new plugin", async () => {
		const f = fixture();
		let accept!: (allowed: boolean) => void;
		f.confirm.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					accept = resolve;
				}),
		);
		const remote = f.gate.authorizeRemote();
		await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
		const load = vi.fn(async () => ({ code: "new" }));
		const serving = f.gate.serve("new", load);
		expect(load).not.toHaveBeenCalled();
		accept(true);
		await remote;
		await serving;
		expect(f.confirm.mock.calls.map(([names]) => names)).toEqual([["legacy"], ["new"]]);
		expect(load).toHaveBeenCalledOnce();
	});
	it("keeps enable then disable submission order while confirmation is pending", async () => {
		const f = fixture();
		let accept!: (allowed: boolean) => void;
		f.confirm.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					accept = resolve;
				}),
		);
		const writes: boolean[] = [];
		const enable = f.gate.configurePlugin("legacy", true, async () => {
			writes.push(true);
		});
		const disable = f.gate.configurePlugin("legacy", false, async () => {
			writes.push(false);
		});
		await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
		expect(writes).toEqual([]);
		accept(true);
		await Promise.all([enable, disable]);
		expect(writes).toEqual([true, false]);
	});
	it("does not treat a failed trust write as approval and still remembers served code after config damage", async () => {
		const f = fixture();
		await f.gate.serve("legacy", async () => ({ code: "fixture" }));
		f.set({ enabled: false, plugins: {}, assignments: {} });
		f.approve.mockRejectedValueOnce(new Error("corrupt config"));
		await expect(f.gate.authorizeRemote()).rejects.toThrow("corrupt config");
		f.gate.resetDecline();
		await f.gate.authorizeRemote();
		expect(f.confirm).toHaveBeenCalledTimes(2);
		expect(f.config().plugins.legacy?.workbenchTrusted).toBe(true);
	});
});
