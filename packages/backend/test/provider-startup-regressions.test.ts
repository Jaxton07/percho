import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";

let root: string;
let agentDir: string;
let cwd: string;
let backend: PiBackend;

// 不读取用户凭证，也不允许模型请求离开测试进程。
beforeEach(async () => {
	root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "provider-startup-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
	vi.stubEnv("HOME", root);
	vi.stubEnv("USERPROFILE", root);
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
	vi.stubEnv("TMPDIR", root);
	vi.stubEnv("TMP", root);
	vi.stubEnv("TEMP", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_LOG_DIR", join(root, "logs"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Unexpected external request");
		}),
	);
	await writeFile(join(agentDir, "auth.json"), "{}");
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
	backend = new PiBackend({ defaultCwd: cwd, webFetch: false, permissionGates: false });
});

afterEach(async () => {
	await backend?.shutdown();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

const nativeFactory = `export default function(pi) {
	pi.registerProvider({
		id: "fixture-provider", name: "Fixture",
		auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-fixture" } }) } },
		getModels: () => [],
	});
	pi.on("session_start", () => { throw new Error("Unexpected session_start"); });
}`;

const activationFactory = `export default function(pi) {
	pi.events.emit("percho:provider-activation:v1", {
		version: 1, id: "example-provider",
		async activate(runtime) {
			let models = [];
			runtime.registerNativeProvider({
				id: "example-provider", name: "Example",
				auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-fixture" } }) } },
				getModels: () => models,
				async refreshModels(ctx) {
					if (!ctx.allowNetwork) return;
					const response = await fetch("http://127.0.0.1:9/catalog", { signal: ctx.signal });
					if (!response.ok) throw new Error("catalog status " + response.status);
					const data = await response.json();
					await ctx.publish({ update: () => { models = data; } });
				},
			});
			return { deactivate() { runtime.unregisterProvider("example-provider"); } };
		},
	});
}`;

function catalogModel(id = "example-model") {
	return {
		id,
		name: id,
		provider: "example-provider",
		api: "fixture-api",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// 从已固定 SDK 的公开入口定位同一模块，不固定开发机路径。
const nativeRequire = createRequire(import.meta.url);
const configPath = nativeRequire.resolve
	.paths("@earendil-works/pi-coding-agent")
	?.map((path) => join(path, "@earendil-works/pi-coding-agent/dist/core/model-config.js"))
	.find(existsSync);
if (!configPath) throw new Error("Missing installed SDK ModelConfig");
const { ModelConfig } = nativeRequire(configPath) as {
	ModelConfig: { load(path?: string): Promise<unknown> };
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it.each([
	{ mode: "v1", delay: false },
	{ mode: "v1", delay: true },
	{ mode: "ordinary", delay: false },
	{ mode: "ordinary", delay: true },
])("真实 SDK $mode 延迟配置读取=$delay 仍交付启动目录", async ({ mode, delay }) => {
	const body = activationFactory.slice(
		activationFactory.indexOf("let models = [];"),
		activationFactory.indexOf("return { deactivate()"),
	);
	const factory =
		mode === "v1"
			? activationFactory
			: `export default function(pi) {${body.replace("runtime.registerNativeProvider", "pi.registerProvider")}}`;
	await writeFile(join(agentDir, "extensions", "fixture.ts"), factory);
	const gate = deferred<void>();
	const implicitDone = deferred<void>();
	const load = ModelConfig.load;
	let held = false;
	vi.spyOn(ModelConfig, "load").mockImplementation(async function (path) {
		if (delay && !held && (new Error().stack ?? "").includes("registerNativeProvider")) {
			held = true;
			await gate.promise;
		}
		return load.call(this, path);
	});
	const refresh = ModelRuntime.prototype.refresh;
	vi.spyOn(ModelRuntime.prototype, "refresh").mockImplementation(async function (options) {
		const stack = new Error().stack ?? "";
		const implicit = stack.includes("registerNativeProvider");
		try {
			return await refresh.call(this, options);
		} finally {
			if (implicit) implicitDone.resolve();
			// 后续显式离线刷新已完成才释放旧读取；不依赖在线请求启动，也不靠睡眠。
			if (
				!implicit &&
				held &&
				options?.allowNetwork === false &&
				stack.includes("ProviderStartup.activate")
			) {
				setImmediate(() => gate.resolve());
			}
		}
	});
	vi.mocked(fetch).mockImplementation(async () => {
		await implicitDone.promise;
		return new Response(JSON.stringify([catalogModel("load-race-model")]));
	});
	try {
		await backend.init();
		expect(held).toBe(delay);
		expect((await backend.listModels()).map((model) => model.id)).toContain("load-race-model");
		expect(backend.getProviderStartupDiagnostics()).toEqual([]);
	} finally {
		gate.resolve();
	}
});

it.each(["native", "config", "unregister"])("SDK %s 隐式刷新必须被 settle 等待", async (operation) => {
	const runtime = await ModelRuntime.create({ modelsPath: null });
	const gate = deferred<void>();
	const entered = deferred<void>();
	const original = ModelConfig.load;
	vi.spyOn(ModelConfig, "load").mockImplementation(async function (path) {
		entered.resolve();
		await gate.promise;
		return original.call(this, path);
	});
	if (operation === "native") {
		runtime.registerNativeProvider({
			id: "fixture-provider",
			name: "Fixture",
			auth: {},
			getModels: () => [],
		});
	} else if (operation === "config") {
		runtime.registerProvider("fixture-provider", {
			api: "fixture-api",
			baseUrl: "http://127.0.0.1:9",
			models: [],
		});
	} else {
		runtime.unregisterProvider("fixture-provider");
	}
	await entered.promise;
	let settled = false;
	const settlement = runtime.settleRegistrationRefreshes().then(() => {
		settled = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
	} finally {
		gate.resolve();
		await settlement;
	}
	expect(settled).toBe(true);
});

it("SDK 隐式读取失败由 settle 报告且下一次可恢复", async () => {
	const runtime = await ModelRuntime.create({ modelsPath: null });
	vi.spyOn(ModelConfig, "load").mockRejectedValueOnce(new Error("fixture config read failure"));
	runtime.registerNativeProvider({ id: "fixture-provider", name: "Fixture", auth: {}, getModels: () => [] });
	await expect(runtime.settleRegistrationRefreshes()).rejects.toThrow("fixture config read failure");
	runtime.unregisterProvider("fixture-provider");
	await expect(runtime.settleRegistrationRefreshes()).resolves.toBeUndefined();
});

const staticModel = { ...catalogModel("static-model"), provider: "fixture-provider" };
const nativePackage = nativeFactory
	.replace("getModels: () => [],", `getModels: () => [${JSON.stringify(staticModel)}],`)
	.replace('pi.on("session_start", () => { throw new Error("Unexpected session_start"); });', "");
const configPackage = `export default function(pi) {
	pi.registerProvider("fixture-provider", {
		api: "fixture-api", apiKey: "fixture-key", baseUrl: "http://127.0.0.1:9",
		models: [${JSON.stringify(staticModel)}],
	});
}`;

it.each([
	{ mode: "native", factory: nativePackage },
	{ mode: "config", factory: configPackage },
])("$mode 普通包经真实会话重注册后可卸载无关包和自身", async ({ factory }) => {
	const ordinary = join(root, "ordinary-package");
	const unrelated = join(root, "unrelated-package");
	for (const [path, body] of [
		[ordinary, factory],
		[unrelated, "export default function(pi) {}"],
	]) {
		await mkdir(path);
		await writeFile(
			join(path, "package.json"),
			JSON.stringify({ name: "fixture-package", pi: { extensions: ["index.ts"] } }),
		);
		await writeFile(join(path, "index.ts"), body);
	}
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [ordinary, unrelated] }));
	await writeFile(join(agentDir, "extensions", "activation.ts"), activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	const state = backend as unknown as {
		modelRuntime: import("@earendil-works/pi-coding-agent").ModelRuntime;
	};
	const registration = () =>
		state.modelRuntime.getRegisteredNativeProvider("fixture-provider") ??
		state.modelRuntime.getRegisteredProviderConfig("fixture-provider");
	const original = registration();
	const session = await backend.createSession({ cwd, provider: "fixture-provider", modelId: "static-model" });
	expect(registration()).not.toBe(original);
	await backend.packages.removePackage(unrelated, "user");
	expect(registration()).toBeDefined();
	expect((await backend.listModels()).map((model) => model.id)).toEqual(
		expect.arrayContaining(["static-model", "example-model"]),
	);
	await backend.packages.removePackage(ordinary, "user");
	expect(registration()).toBeUndefined();
	expect(state.modelRuntime.getRegisteredNativeProvider("example-provider")).toBeDefined();
	await backend.closeSession(session.sessionId);
});

it.each([undefined, "foreign-extension"])(
	"不同来源 %s 替换仍是冲突，重载不能覆盖或清理它",
	async (source) => {
		await writeFile(join(agentDir, "extensions", "ordinary.ts"), nativePackage);
		await backend.init();
		const state = backend as unknown as {
			modelRuntime: import("@earendil-works/pi-coding-agent").ModelRuntime;
			loadUserProviders(runtime: unknown): Promise<void>;
		};
		const replacement = { id: "fixture-provider", name: "Replacement", auth: {}, getModels: () => [] };
		state.modelRuntime.registerNativeProvider(replacement, source);
		await expect(state.loadUserProviders(state.modelRuntime)).rejects.toThrow(
			"Provider registration conflict",
		);
		expect(state.modelRuntime.getRegisteredNativeProvider("fixture-provider")).toBe(replacement);
	},
);

it("reload 后入队的旧代 refresh 不阻塞等待它的 deactivate", async () => {
	const file = join(agentDir, "extensions", "activation.ts");
	await writeFile(
		file,
		activationFactory.replace(
			'return { deactivate() { runtime.unregisterProvider("example-provider"); } };',
			`let pending;
		runtime.getRegisteredNativeProvider("example-provider").schedule = () => pending = runtime.refresh({ allowNetwork: false });
		return { async deactivate() { if (pending) { try { await pending; } catch {} } } };`,
		),
	);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	const state = backend as unknown as {
		modelRuntime: import("@earendil-works/pi-coding-agent").ModelRuntime;
		loadUserProviders(runtime: unknown): Promise<void>;
	};
	const provider = state.modelRuntime.getRegisteredNativeProvider("example-provider") as unknown as {
		schedule(): Promise<unknown>;
	};
	await rm(file);
	const reload = state.loadUserProviders(state.modelRuntime);
	const refresh = provider.schedule();
	await expect(refresh).rejects.toThrow("Provider activation revoked");
	await reload;
	expect(state.modelRuntime.getRegisteredNativeProvider("example-provider")).toBeUndefined();
});
