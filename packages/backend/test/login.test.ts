import type { LoginEventPayload } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { filterAuthSelectOptions, LoginService, type LoginServiceDeps } from "../src/settings/login";

/** 登录流程的 provider 最小 stub（只覆盖 LoginService 用到的字段） */
function makeProvider(overrides: { id: string; name: string; oauth?: unknown; apiKeyLogin?: boolean }) {
	return {
		id: overrides.id,
		name: overrides.name,
		auth: {
			...(overrides.oauth ? { oauth: overrides.oauth } : {}),
			apiKey: overrides.apiKeyLogin ? { login: async () => ({ type: "api_key", key: "k" }) } : undefined,
		},
	} as never;
}

function makeService(
	providers: ReturnType<typeof makeProvider>[],
	runtimeLogin?: (providerId: string, type: string, interaction: unknown) => Promise<unknown>,
) {
	const events = [] as LoginEventPayload[];
	const captured = [] as { providerId: string; type: string }[];
	const service = new LoginService({
		getRuntime: async () =>
			({
				getProvider: (id: string) => providers.find((p) => p.id === id),
				login: vi.fn(async (providerId: string, type: string, interaction: unknown) => {
					captured.push({ providerId, type });
					return runtimeLogin ? runtimeLogin(providerId, type, interaction) : { type: "api_key", key: "k" };
				}),
			}) as never,
		send: (payload) => events.push(payload),
	} as LoginServiceDeps);
	return { service, events, captured };
}

describe("filterAuthSelectOptions", () => {
	const vertexOptions = [
		{ id: "api-key", label: "Google Cloud API key" },
		{ id: "adc", label: "Application Default Credentials" },
		{ id: "service-account", label: "Service account credentials file" },
	];

	it("google-vertex 剔除 api-key（Vertex 端点不接受 API key，见 PITFALLS）", () => {
		const filtered = filterAuthSelectOptions("google-vertex", vertexOptions);
		expect(filtered.map((o) => o.id)).toEqual(["adc", "service-account"]);
	});

	it("其他 provider 原样透传（不含 description 的类型也兼容）", () => {
		const options = [
			{ id: "a", label: "A" },
			{ id: "b", label: "B", description: "B desc" },
		];
		expect(filterAuthSelectOptions("other-provider", options)).toEqual(options);
	});

	it("google-vertex 无多余选项时安全返回空", () => {
		expect(filterAuthSelectOptions("google-vertex", [])).toEqual([]);
	});
});

describe("LoginService.startLogin", () => {
	it("完整流程：auth_url 事件转发 + manual_code 提示应答 + 成功收尾", async () => {
		const { service, events, captured } = makeService(
			[makeProvider({ id: "anthropic", name: "Anthropic", oauth: { loginLabel: "Sign in" } })],
			async (_pid, _type, interaction) => {
				await (interaction as { notify: (e: unknown) => void }).notify({ type: "auth_url" });
				const code = await (interaction as { prompt: (p: unknown) => Promise<string> }).prompt({
					type: "manual_code",
					message: "paste code",
				});
				expect(code).toBe("auth-code-123");
				return { type: "oauth" };
			},
		);
		const promise = service.startLogin("L1", "anthropic");
		await vi.waitFor(() => {
			expect(events.some((e) => e.kind === "prompt")).toBe(true);
		});
		const promptPayload = events.find((e) => e.kind === "prompt");
		if (promptPayload?.kind !== "prompt") throw new Error("unreachable");
		service.respond("L1", promptPayload.promptId, "auth-code-123");
		await expect(promise).resolves.toEqual({ ok: true });
		expect(events.map((e) => e.kind)).toEqual(["event", "prompt"]);
		expect(captured).toEqual([{ providerId: "anthropic", type: "oauth" }]);
	});

	it("prompt.signal 外部取消（浏览器回调先到）：prompt-cancel 事件 + 挂起 promise 被拒", async () => {
		const { service, events } = makeService(
			[makeProvider({ id: "anthropic", name: "Anthropic", oauth: {} })],
			async (_pid, _type, interaction) => {
				// 模拟 codex：挂起 manual_code 后浏览器回调先到，SDK abort 该 prompt 的 signal
				const controller = new AbortController();
				const pending = (interaction as { prompt: (p: unknown) => Promise<string> }).prompt({
					type: "manual_code",
					message: "paste",
					signal: controller.signal,
				});
				controller.abort();
				await expect(pending).rejects.toThrow("Login cancelled");
				return { type: "oauth" };
			},
		);
		const result = await service.startLogin("L2", "anthropic");
		expect(result).toEqual({ ok: true });
		expect(events.filter((e) => e.kind === "prompt-cancel")).toHaveLength(1);
	});

	it("用户取消：abort 后返回 cancelled:true 并回收挂起 prompt", async () => {
		const { service, events } = makeService(
			[makeProvider({ id: "anthropic", name: "Anthropic", oauth: {} })],
			async (_pid, _type, interaction) => {
				const pending = (interaction as { prompt: (p: unknown) => Promise<string> }).prompt({
					type: "text",
					message: "domain?",
				});
				void pending.catch((e: Error) => e.message);
				// 等取消信号后按 SDK 语义抛错
				await new Promise<void>((resolve) => {
					const sig = (interaction as { signal: AbortSignal }).signal;
					if (sig.aborted) return resolve();
					sig.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("Login cancelled");
			},
		);
		const promise = service.startLogin("L3", "anthropic");
		await vi.waitFor(() => {
			expect(events.some((e) => e.kind === "prompt")).toBe(true);
		});
		service.cancel("L3");
		await expect(promise).resolves.toMatchObject({ ok: false, cancelled: true });
		expect(events.filter((e) => e.kind === "prompt-cancel")).toHaveLength(1);
	});

	it("未知 promptId / 非当前 loginId 的应答静默忽略", async () => {
		const { service, events } = makeService(
			[makeProvider({ id: "anthropic", name: "Anthropic", oauth: {} })],
			async (_pid, _type, interaction) => {
				const value = await (interaction as { prompt: (p: unknown) => Promise<string> }).prompt({
					type: "text",
					message: "x",
				});
				expect(value).toBe("real");
				return { type: "oauth" };
			},
		);
		const promise = service.startLogin("L6", "anthropic");
		await vi.waitFor(() => {
			expect(events.some((e) => e.kind === "prompt")).toBe(true);
		});
		service.respond("L6", "bogus", "junk");
		service.respond("OTHER", "L6:1", "junk");
		const promptPayload = events.find((e) => e.kind === "prompt");
		if (promptPayload?.kind !== "prompt") throw new Error("unreachable");
		service.respond("L6", promptPayload.promptId, "real");
		await expect(promise).resolves.toEqual({ ok: true });
	});

	it("oauth provider 走 oauth 登录", async () => {
		const { service, captured } = makeService([
			makeProvider({ id: "anthropic", name: "Anthropic", oauth: { loginLabel: "Sign in" } }),
		]);
		const result = await service.startLogin("l1", "anthropic");
		expect(result).toEqual({ ok: true });
		expect(captured).toEqual([{ providerId: "anthropic", type: "oauth" }]);
	});

	it("无 oauth 但有 api_key 交互登录的 provider 走 api_key（如 Google Vertex）", async () => {
		const { service, captured } = makeService([
			makeProvider({ id: "google-vertex", name: "Google Vertex AI", apiKeyLogin: true }),
		]);
		const result = await service.startLogin("l1", "google-vertex");
		expect(result).toEqual({ ok: true });
		expect(captured).toEqual([{ providerId: "google-vertex", type: "api_key" }]);
	});

	it("两者皆无返回不支持登录", async () => {
		const { service, captured } = makeService([
			// resolve-only provider（模型.json 自定义之外的场景）：无 oauth 也无交互 login
			makeProvider({ id: "local", name: "Local" }),
		]);
		const result = await service.startLogin("l1", "local");
		expect(result.ok).toBe(false);
		expect(captured).toHaveLength(0);
	});

	it("未知 provider 报错", async () => {
		const { service } = makeService([]);
		const result = await service.startLogin("l1", "nope");
		expect(result.ok).toBe(false);
	});

	it("重复发起会先取消旧流程（renderer 崩溃残留场景）", async () => {
		// 旧流程挂起在 SDK 交互上（不响应 prompt），新发起应取消它并正常完成
		let calls = 0;
		const { service, captured } = makeService(
			[makeProvider({ id: "google-vertex", name: "Google Vertex AI", apiKeyLogin: true })],
			async (_pid, _type, interaction) => {
				calls++;
				if (calls === 1) {
					// 第一次：挂起等 signal abort（模拟旧流程无应答）
					await new Promise((_resolve, reject) => {
						const sig = (interaction as { signal: AbortSignal }).signal;
						if (sig.aborted) return reject(new Error("Login cancelled"));
						sig.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
					});
				}
				return { type: "api_key", key: "k" };
			},
		);
		const p1 = service.startLogin("l-old", "google-vertex");
		await vi.waitFor(() => expect(captured.length).toBe(1));
		const p2 = service.startLogin("l-new", "google-vertex");
		await expect(p1).resolves.toEqual({ ok: false, cancelled: true, error: "Login cancelled" });
		await expect(p2).resolves.toEqual({ ok: true });
	});

	it("vertex select 提示经桥接层剔除 api-key 选项", async () => {
		const { service, events } = makeService(
			[makeProvider({ id: "google-vertex", name: "Google Vertex AI", apiKeyLogin: true })],
			async (_pid, _type, interaction) => {
				// 模拟 SDK 交互：发出三选一 select，等待 renderer 应答
				await (interaction as { prompt: (p: unknown) => Promise<string> }).prompt({
					type: "select",
					message: "Select auth method",
					options: [
						{ id: "api-key", label: "Google Cloud API key" },
						{ id: "adc", label: "Application Default Credentials" },
					],
				});
				return { type: "api_key", key: undefined as never };
			},
		);
		const promise = service.startLogin("l1", "google-vertex");
		// 事件先到：拿到挂起的 select prompt 后模拟 renderer 应答
		await vi.waitFor(() => {
			expect(events.some((e) => e.kind === "prompt")).toBe(true);
		});
		const promptEvent = events.find((e) => e.kind === "prompt");
		expect(promptEvent?.kind).toBe("prompt");
		if (promptEvent?.kind === "prompt") {
			expect(promptEvent.prompt.type).toBe("select");
			if (promptEvent.prompt.type === "select") {
				expect(promptEvent.prompt.options.map((o) => o.id)).toEqual(["adc"]);
			}
		}
		service.respond("l1", promptEvent?.kind === "prompt" ? promptEvent.promptId : "", "adc");
		await expect(promise).resolves.toEqual({ ok: true });
	});
});
