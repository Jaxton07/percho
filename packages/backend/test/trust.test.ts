import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildTrustOptions, resolveProjectTrust, TrustGate } from "../src/trust";

function makeProject(): { cwd: string; agentDir: string; trustStore: ProjectTrustStore } {
	const root = mkdtempSync(join(tmpdir(), "pi-trust-test-"));
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir, trustStore: new ProjectTrustStore(agentDir) };
}

describe("buildTrustOptions", () => {
	it("生成与 CLI 一致的五个选项（含父目录）", () => {
		const { cwd } = makeProject();
		const options = buildTrustOptions(cwd);
		expect(options.map((o) => o.key)).toEqual([
			"trust",
			"trustParent",
			"trustSession",
			"deny",
			"denySession",
		]);

		const [trust, trustParent, trustSession, deny, denySession] = options;
		expect(trust.updates).toHaveLength(1);
		expect(trust.updates[0].decision).toBe(true);
		expect(trustParent.updates).toEqual([
			{ path: trustParent.parentPath, decision: true },
			{ path: trust.updates[0].path, decision: null },
		]);
		expect(trustSession.updates).toHaveLength(0);
		expect(deny.updates[0].decision).toBe(false);
		expect(denySession.updates).toHaveLength(0);
	});
});

describe("resolveProjectTrust", () => {
	it("无信任需求资源的项目直接可信，不问用户", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-trust-test-"));
		const cwd = join(root, "plain");
		mkdirSync(cwd, { recursive: true });
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		let asked = false;
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "ask",
			askUser: async () => {
				asked = true;
				return undefined;
			},
		});
		expect(trusted).toBe(true);
		expect(asked).toBe(false);
	});

	it("trust.json 有记录时直接用记录，不问用户", async () => {
		const { cwd, trustStore } = makeProject();
		trustStore.set(cwd, true);
		let asked = false;
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			askUser: async () => {
				asked = true;
				return 2;
			},
		});
		expect(trusted).toBe(true);
		expect(asked).toBe(false);
	});

	it("父目录的信任记录对子目录生效", async () => {
		const { cwd, trustStore } = makeProject();
		const parent = join(cwd, "..");
		trustStore.set(parent, false);
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			askUser: async () => 0,
		});
		expect(trusted).toBe(false);
	});

	it("defaultProjectTrust always/never 直接生效", async () => {
		const { cwd, trustStore } = makeProject();
		await expect(resolveProjectTrust({ cwd, trustStore, defaultProjectTrust: "always" })).resolves.toBe(true);
		await expect(resolveProjectTrust({ cwd, trustStore, defaultProjectTrust: "never" })).resolves.toBe(false);
	});

	it("无 UI（无 askUser）时按不信任处理", async () => {
		const { cwd, trustStore } = makeProject();
		await expect(resolveProjectTrust({ cwd, trustStore, defaultProjectTrust: "ask" })).resolves.toBe(false);
	});

	it("选择 trust 写入 trust.json 并返回可信", async () => {
		const { cwd, trustStore } = makeProject();
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			askUser: async () => 0,
		});
		expect(trusted).toBe(true);
		expect(trustStore.get(cwd)).toBe(true);
	});

	it("选择 trustParent 写父目录并清除子目录记录", async () => {
		const { cwd, trustStore } = makeProject();
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			askUser: async (_dir, options) => options.findIndex((o) => o.key === "trustParent"),
		});
		expect(trusted).toBe(true);
		const parent = join(cwd, "..");
		expect(trustStore.get(parent)).toBe(true);
	});

	it("选择 trustSession 不写 trust.json", async () => {
		const { cwd, trustStore } = makeProject();
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			askUser: async (_dir, options) => options.findIndex((o) => o.key === "trustSession"),
		});
		expect(trusted).toBe(true);
		expect(trustStore.get(cwd)).toBeNull();
	});

	it("选择 deny 写入不信任；denySession 不写", async () => {
		const { cwd, trustStore } = makeProject();
		const denied = await resolveProjectTrust({
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			askUser: async (_dir, options) => options.findIndex((o) => o.key === "deny"),
		});
		expect(denied).toBe(false);
		expect(trustStore.get(cwd)).toBe(false);

		const other = makeProject();
		const sessionDenied = await resolveProjectTrust({
			cwd: other.cwd,
			trustStore: other.trustStore,
			defaultProjectTrust: "ask",
			askUser: async (_dir, options) => options.findIndex((o) => o.key === "denySession"),
		});
		expect(sessionDenied).toBe(false);
		expect(other.trustStore.get(other.cwd)).toBeNull();
	});

	it("用户取消（undefined）按不信任且不写记录", async () => {
		const { cwd, trustStore } = makeProject();
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			askUser: async () => undefined,
		});
		expect(trusted).toBe(false);
		expect(trustStore.get(cwd)).toBeNull();
	});
});

describe("TrustGate", () => {
	function makeGate() {
		const requests: { id: string; optionCount: number }[] = [];
		const gate = new TrustGate((req) => requests.push({ id: req.id, optionCount: req.options.length }));
		return { gate, requests };
	}

	it("发出 trust request 并等待应答", async () => {
		const { gate, requests } = makeGate();
		const options = buildTrustOptions("/tmp/project-x");
		const promise = gate.ask("/tmp/project-x", options);
		expect(requests).toHaveLength(1);
		expect(requests[0].optionCount).toBe(options.length);

		gate.respond(requests[0].id, 1);
		await expect(promise).resolves.toBe(1);
	});

	it("越界下标按取消处理", async () => {
		const { gate, requests } = makeGate();
		const promise = gate.ask("/tmp/project-x", buildTrustOptions("/tmp/project-x"));
		gate.respond(requests[0].id, 99);
		await expect(promise).resolves.toBeUndefined();
	});

	it("dispose 时未决请求按取消处理", async () => {
		const { gate } = makeGate();
		const promise = gate.ask("/tmp/project-x", buildTrustOptions("/tmp/project-x"));
		gate.dispose();
		await expect(promise).resolves.toBeUndefined();
	});
});
