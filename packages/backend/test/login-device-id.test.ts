import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginService } from "../src/settings/login";

let directory: string | undefined;

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function setup() {
	const root = resolve(import.meta.dirname, "../../../.local/tmp/issue-117");
	await mkdir(root, { recursive: true });
	directory = await mkdtemp(join(root, "case-"));
	const agentDir = join(directory, "agent");
	const projectDir = join(directory, "project");
	await mkdir(join(projectDir, ".pi"), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.spyOn(process, "cwd").mockReturnValue(projectDir);
	const login = vi
		.fn<ModelRuntime["login"]>()
		.mockImplementation(async (_provider, _method, _interaction, options) => {
			const deviceId = options?.getDeviceId?.();
			if (!deviceId) throw new Error("Missing device ID");
			expect(options?.getDeviceId?.()).toBe(deviceId);
			return { type: "api_key", key: deviceId };
		});
	const runtime = {
		getProvider: () => ({ id: "openai", auth: { oauth: {} } }),
		login,
	} as unknown as ModelRuntime;
	const createService = () => new LoginService({ getRuntime: async () => runtime, send: () => {} });
	const readSettings = async () => JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	return { agentDir, projectDir, login, createService, readSettings };
}

describe("登录设备标识", () => {
	it("首次登录生成 UUID，重复登录和重建服务后复用落盘标识，忽略项目配置", async () => {
		const { projectDir, login, createService, readSettings } = await setup();
		const projectDeviceId = "11111111-1111-4111-8111-111111111111";
		await writeFile(join(projectDir, ".pi/settings.json"), JSON.stringify({ deviceId: projectDeviceId }));
		const service = createService();
		await expect(service.startLogin("first", "openai")).resolves.toEqual({ ok: true });
		const credential = await login.mock.results[0].value;
		if (credential.type !== "api_key") throw new Error("Unexpected credential type");
		const deviceId = credential.key;
		expect(deviceId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
		expect(deviceId).not.toBe(projectDeviceId);
		await vi.waitFor(async () => expect((await readSettings()).deviceId).toBe(deviceId));
		await expect(service.startLogin("second", "openai")).resolves.toEqual({ ok: true });
		service.dispose();
		const restarted = createService();
		await expect(restarted.startLogin("restart", "openai")).resolves.toEqual({ ok: true });
		for (const result of login.mock.results) {
			await expect(result.value).resolves.toEqual({ type: "api_key", key: deviceId });
		}
		restarted.dispose();
	});

	it("已有设备标识时直接复用，保留其他全局设置", async () => {
		const { agentDir, login, createService, readSettings } = await setup();
		const settings = { deviceId: "22222222-2222-4222-8222-222222222222", theme: "dark" };
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
		const service = createService();
		await expect(service.startLogin("existing", "openai")).resolves.toEqual({ ok: true });
		await expect(login.mock.results[0].value).resolves.toEqual({ type: "api_key", key: settings.deviceId });
		expect(await readSettings()).toEqual(settings);
		service.dispose();
	});

	it("不需要设备标识的登录不创建设置文件", async () => {
		const { login, createService, readSettings } = await setup();
		login.mockResolvedValue({ type: "api_key", key: "fixture-key" });
		const service = createService();
		await expect(service.startLogin("other", "openai")).resolves.toEqual({ ok: true });
		await expect(readSettings()).rejects.toMatchObject({ code: "ENOENT" });
		service.dispose();
	});
});
