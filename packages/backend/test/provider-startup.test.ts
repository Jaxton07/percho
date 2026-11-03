import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("真实 SDK 在零会话启动时加载用户级普通 native provider 工厂", async () => {
	await writeFile(join(agentDir, "extensions", "fixture.ts"), nativeFactory);
	await backend.init();
	expect((await backend.settings.listProviders()).some((p) => p.id === "fixture-provider")).toBe(true);
	expect(await backend.listSessions(cwd)).toEqual([]);
	const entries = await readdir(join(agentDir, "sessions"), { recursive: true }).catch(() => []);
	expect(entries.filter((entry) => entry.endsWith(".jsonl"))).toEqual([]);
});

it("v1 激活在零会话启动时等待动态目录 ready", async () => {
	await writeFile(join(agentDir, "extensions", "fixture.ts"), activationFactory);
	vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	expect((await backend.listModels()).map((m) => m.id)).toContain("example-model");
	expect(await backend.listSessions(cwd)).toEqual([]);
});

it("v1 公开原生实例查询，并与后续真实会话复用同一实例", async () => {
	const factory = activationFactory.replace(
		"let models = [];",
		`if (runtime.getRegisteredNativeProvider("example-provider") || runtime.getRegisteredProviderConfig("example-provider")) throw new Error("Unexpected existing registration");
		let models = [];`,
	);
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		factory.replace(
			"\n}",
			`
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.modelRegistry.getRegisteredNativeProvider("example-provider")) throw new Error("Missing shared provider");
	});
}`,
		),
	);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	const runtime = (
		backend as unknown as {
			modelRuntime: { getRegisteredNativeProvider(id: string): unknown };
		}
	).modelRuntime;
	const original = runtime.getRegisteredNativeProvider("example-provider");
	expect(original).toBeDefined();
	for (let index = 0; index < 2; index++) {
		const session = await backend.createSession({
			cwd,
			provider: "example-provider",
			modelId: "example-model",
		});
		expect(runtime.getRegisteredNativeProvider("example-provider")).toBe(original);
		expect((await backend.listModels()).map((model) => model.id)).toContain("example-model");
		await backend.closeSession(session.sessionId);
	}
	expect(runtime.getRegisteredNativeProvider("example-provider")).toBe(original);
});

it("用户包卸载在零会话时撤销 native 和 v1 provider", async () => {
	const pkg = join(root, "fixture-package");
	await mkdir(pkg);
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name: "fixture-provider", pi: { extensions: ["native.ts", "activation.ts"] } }),
	);
	await writeFile(join(pkg, "native.ts"), nativeFactory);
	await writeFile(join(pkg, "activation.ts"), activationFactory);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	expect((await backend.settings.listProviders()).map((p) => p.id)).toContain("example-provider");
	await backend.packages.removePackage(pkg, "user");
	const providers = (await backend.settings.listProviders()).map((p) => p.id);
	expect(providers).not.toContain("fixture-provider");
	expect(providers).not.toContain("example-provider");
});

it("目录 503 不阻止启动且可诊断，显式刷新恢复", async () => {
	await writeFile(join(agentDir, "extensions", "fixture.ts"), activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response("unavailable", { status: 503 }));
	await backend.init();
	expect((await backend.settings.listProviders()).map((p) => p.id)).toContain("example-provider");
	expect(await backend.listModels()).toEqual([]);
	expect(backend.getProviderStartupDiagnostics()).toContainEqual({
		phase: "catalog",
		providerId: "example-provider",
	});
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.settings.listProviders({ forceNetwork: true });
	expect((await backend.listModels()).map((m) => m.id)).toContain("example-model");
	expect(backend.getProviderStartupDiagnostics()).toEqual([]);
});

it("本地列表读取不能取消显式在线刷新发布", async () => {
	await writeFile(join(agentDir, "extensions", "fixture.ts"), activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	let release!: (response: Response) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	vi.mocked(fetch).mockImplementation(() => {
		entered();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const online = backend.settings.listProviders({ forceNetwork: true });
	await started;
	const offline = backend.settings.listProviders();
	// 给默认列表读取一次进入 SDK 的机会，然后释放真实 SDK 的目录发布。
	await new Promise((resolve) => setTimeout(resolve, 30));
	release(new Response(JSON.stringify([catalogModel("updated-model")])));
	await Promise.all([online, offline]);
	expect((await backend.listModels()).map((m) => m.id)).toContain("updated-model");
});

it("工厂发出声明后加载失败时不能激活该声明", async () => {
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		activationFactory.replace("\n}", '\nthrow new Error("fixture factory failure");\n}'),
	);
	await expect(backend.init()).rejects.toThrow("Provider resource loading failed");
	expect(fetch).not.toHaveBeenCalled();
});

it("启动不执行未信任项目资源，即使会话配置允许自动信任", async () => {
	await backend.shutdown();
	backend = new PiBackend({ defaultCwd: cwd, projectTrust: false, webFetch: false });
	await writeFile(join(cwd, ".pi", "extensions", "project.ts"), nativeFactory);
	await writeFile(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ extensions: ["./extensions/project.ts"] }),
	);
	await backend.init();
	expect((await backend.settings.listProviders()).map((p) => p.id)).not.toContain("fixture-provider");
	expect(fetch).not.toHaveBeenCalled();
});

it("普通配置工厂走 SDK services 注册，不要求 v1 声明", async () => {
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		`export default function(pi) {
		pi.registerProvider("fixture-provider", { api: "fixture-api", apiKey: "synthetic-fixture",
			baseUrl: "http://127.0.0.1:9", models: [${JSON.stringify(catalogModel())}] });
	}`,
	);
	await backend.init();
	expect((await backend.listModels()).some((m) => m.provider === "fixture-provider")).toBe(true);
});

it("全量刷新保留其他 native provider 的 filterModels", async () => {
	await writeFile(
		join(agentDir, "extensions", "native.ts"),
		nativeFactory.replace(
			"getModels: () => [],",
			`getModels: () => [${JSON.stringify({ ...catalogModel("hidden-model"), provider: "fixture-provider" })}], filterModels: () => [],`,
		),
	);
	await writeFile(join(agentDir, "extensions", "activation.ts"), activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	const runtime = (backend as unknown as { modelRuntime: { getAvailableSnapshot(): { id: string }[] } })
		.modelRuntime;
	expect(runtime.getAvailableSnapshot().map((m) => m.id)).toContain("example-model");
	expect(runtime.getAvailableSnapshot().map((m) => m.id)).not.toContain("hidden-model");
	await backend.settings.listProviders({ forceNetwork: true });
	expect(runtime.getAvailableSnapshot().map((m) => m.id)).not.toContain("hidden-model");
});

it("shutdown 等待自己的工厂 flight，但不允许晚到的激活", async () => {
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		nativeFactory.replace(
			"function(pi) {",
			'async function(pi) { await fetch("http://127.0.0.1:9/factory");',
		),
	);
	let release!: (response: Response) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	vi.mocked(fetch).mockImplementation(() => {
		entered();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const initialization = backend.init();
	const rejected = expect(initialization).rejects.toThrow("BACKEND_STOPPING");
	await started;
	let stopped = false;
	const shutdown = backend.shutdown().then(() => {
		stopped = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(stopped).toBe(false);
	release(new Response("ready"));
	await Promise.all([shutdown, rejected]);
	await expect(backend.init()).rejects.toThrow("BACKEND_STOPPING");
});

it("单会话关闭不撤销共享 v1 provider", async () => {
	await writeFile(join(agentDir, "extensions", "fixture.ts"), activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	const session = await backend.createSession({
		cwd,
		provider: "example-provider",
		modelId: "example-model",
	});
	await backend.closeSession(session.sessionId);
	expect((await backend.listModels()).map((m) => m.id)).toContain("example-model");
});

it("零会话包安装触发真实资源加载并等待目录", async () => {
	await backend.init();
	const pkg = join(root, "fixture-package");
	await mkdir(pkg);
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name: "fixture-provider", pi: { extensions: ["activation.ts"] } }),
	);
	await writeFile(join(pkg, "activation.ts"), activationFactory);
	// 安装传输替身只落本地包配置；PackageAdmin、loader、SDK 与激活全部是真实路径。
	const admin = backend.packages as unknown as {
		createPackageManager(): {
			packageManager: { installAndPersist(): Promise<void> };
			settingsManager: { flush(): Promise<void>; drainErrors(): [] };
		};
	};
	vi.spyOn(admin, "createPackageManager").mockReturnValue({
		packageManager: {
			installAndPersist: async () => {
				await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
			},
		},
		settingsManager: { flush: async () => {}, drainErrors: () => [] },
	});
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.packages.installPackage("fixture-provider");
	expect((await backend.listModels()).map((m) => m.id)).toContain("example-model");
	expect(await backend.listSessions(cwd)).toEqual([]);
});

it("shutdown 等待包安装触发的资源加载 flight", async () => {
	await backend.init();
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		nativeFactory.replace(
			"function(pi) {",
			'async function(pi) { await fetch("http://127.0.0.1:9/factory");',
		),
	);
	let release!: (response: Response) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	vi.mocked(fetch).mockImplementation(() => {
		entered();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const reload = backend as unknown as {
		loadUserProviders(runtime: unknown): Promise<void>;
		modelRuntime: unknown;
	};
	const work = reload.loadUserProviders(reload.modelRuntime);
	const rejected = expect(work).rejects.toThrow("BACKEND_STOPPING");
	await started;
	let stopped = false;
	const shutdown = backend.shutdown().then(() => {
		stopped = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	const completedTooSoon = stopped;
	release(new Response("ready"));
	await Promise.all([shutdown, rejected]);
	expect(completedTooSoon).toBe(false);
});

it("SDK 注册阶段失败仍撤销已经注册的普通 provider", async () => {
	await backend.init();
	await writeFile(join(agentDir, "extensions", "fixture.ts"), nativeFactory);
	// 注册隐式刷新先行；第二次是 services 等待的本地刷新。
	const state = backend as unknown as {
		modelRuntime: { refresh(): Promise<unknown>; getProvider(id: string): unknown };
		loadUserProviders(runtime: unknown): Promise<void>;
	};
	const refresh = state.modelRuntime.refresh.bind(state.modelRuntime);
	let calls = 0;
	vi.spyOn(state.modelRuntime, "refresh").mockImplementation(() =>
		++calls === 2 ? Promise.reject(new Error("fixture services failure")) : refresh(),
	);
	await expect(state.loadUserProviders(state.modelRuntime)).rejects.toThrow();
	expect(state.modelRuntime.getProvider("fixture-provider")).toBeUndefined();
});

it("v1 必须返回可撤销 handle，缺失时回滚注册", async () => {
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		activationFactory.replace(
			'return { deactivate() { runtime.unregisterProvider("example-provider"); } };',
			"return {};",
		),
	);
	await expect(backend.init()).rejects.toThrow("Provider activation handle is invalid");
});

it("用户级扩展停用后重载撤销旧 provider", async () => {
	const extension = join(agentDir, "extensions", "fixture.ts");
	await writeFile(extension, activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [`-${extension}`] }));
	const state = backend as unknown as {
		loadUserProviders(runtime: unknown): Promise<void>;
		modelRuntime: unknown;
	};
	await state.loadUserProviders(state.modelRuntime);
	expect((await backend.settings.listProviders()).map((p) => p.id)).not.toContain("example-provider");
});

it("activate 内显式 refresh 不与宿主加载队列死锁", async () => {
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		activationFactory.replace(
			"return { deactivate()",
			"await runtime.refresh({ allowNetwork: false }); return { deactivate()",
		),
	);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	expect((await backend.listModels()).map((m) => m.id)).toContain("example-model");
});

it("shutdown 后晚到 activate handle 仍会清理", async () => {
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		activationFactory.replace(
			'return { deactivate() { runtime.unregisterProvider("example-provider"); } };',
			'await fetch("http://127.0.0.1:9/activation"); return { deactivate() { fetch("http://127.0.0.1:9/deactivated"); } };',
		),
	);
	let release!: (response: Response) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	vi.mocked(fetch).mockImplementation(async (url) => {
		if (String(url).endsWith("/activation")) {
			entered();
			return new Promise((resolve) => {
				release = resolve;
			});
		}
		return new Response("ready");
	});
	const initialization = expect(backend.init()).rejects.toThrow("BACKEND_STOPPING");
	await started;
	const shutdown = backend.shutdown();
	release(new Response("ready"));
	await Promise.all([initialization, shutdown]);
	expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9/deactivated");
});

it("关闭不撤销其他调用方后来替换的同 id 实例", async () => {
	await writeFile(join(agentDir, "extensions", "fixture.ts"), nativeFactory);
	await backend.init();
	const runtime = (
		backend as unknown as {
			modelRuntime: {
				getRegisteredNativeProvider(id: string): unknown;
				registerNativeProvider(provider: unknown): void;
			};
		}
	).modelRuntime;
	const replacement = { id: "fixture-provider", name: "Replacement", auth: {}, getModels: () => [] };
	runtime.registerNativeProvider(replacement);
	await backend.shutdown();
	expect(runtime.getRegisteredNativeProvider("fixture-provider")).toBe(replacement);
});

it("撤销句柄中的 refresh 立即拒绝，不等待持有自身的宿主队列", async () => {
	const file = join(agentDir, "extensions", "fixture.ts");
	await writeFile(
		file,
		activationFactory.replace(
			'return { deactivate() { runtime.unregisterProvider("example-provider"); } };',
			`return { async deactivate() {
			try { await Promise.race([runtime.refresh({ allowNetwork: false }), new Promise((_, reject) => setTimeout(() => reject(new Error("fixture cleanup stalled")), 50))]); }
			catch (error) { await fetch("http://127.0.0.1:9/cleanup", { body: error.message }); }
		} };`,
		),
	);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	await rm(file);
	const state = backend as unknown as {
		loadUserProviders(runtime: unknown): Promise<void>;
		modelRuntime: unknown;
	};
	await state.loadUserProviders(state.modelRuntime);
	expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9/cleanup", { body: "Provider activation revoked" });
});

it("普通工厂重复 id 在 SDK 注册前拒绝，不能静默覆盖", async () => {
	await writeFile(join(agentDir, "extensions", "first.ts"), nativeFactory);
	await writeFile(join(agentDir, "extensions", "second.ts"), nativeFactory);
	await expect(backend.init()).rejects.toThrow("Provider registration conflict");
});

it("重复 v1 id 拒绝整代，不能覆盖前一个拥有实例", async () => {
	await writeFile(join(agentDir, "extensions", "first.ts"), activationFactory);
	await writeFile(join(agentDir, "extensions", "second.ts"), activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await expect(backend.init()).rejects.toThrow("Provider activation conflict");
});

it("activate 失败撤销部分注册，修复后 init 可重试", async () => {
	const path = join(agentDir, "extensions", "fixture.ts");
	await writeFile(
		path,
		activationFactory.replace(
			"return { deactivate()",
			'throw new Error("fixture activation failure"); return { deactivate()',
		),
	);
	await expect(backend.init()).rejects.toThrow("fixture activation failure");
	await rm(path);
	await writeFile(join(agentDir, "extensions", "recovered.ts"), activationFactory);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await expect(backend.init()).resolves.toBeUndefined();
	expect((await backend.listModels()).map((m) => m.id)).toContain("example-model");
});

it("shutdown 同步撤销拥有实例，旧闭包不能复活", async () => {
	await writeFile(
		join(agentDir, "extensions", "fixture.ts"),
		activationFactory.replace(
			'runtime.unregisterProvider("example-provider");',
			'runtime.unregisterProvider("example-provider"); runtime.registerNativeProvider({ id: "example-provider" });',
		),
	);
	vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify([catalogModel()])));
	await backend.init();
	const runtime = (backend as unknown as { modelRuntime: { getProvider(id: string): unknown } }).modelRuntime;
	backend.beginShutdown();
	expect(runtime.getProvider("example-provider")).toBeUndefined();
	await backend.shutdown();
	expect(runtime.getProvider("example-provider")).toBeUndefined();
});
