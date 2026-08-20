import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LoginAuthPrompt, LoginEventPayload } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { LoginService } from "../src/settings/login";

type Interaction = {
	signal?: AbortSignal;
	prompt: (prompt: LoginAuthPrompt & { signal?: AbortSignal }) => Promise<string>;
	notify: (event: { type: string }) => void;
};

function makeRuntime(behavior: (interaction: Interaction) => Promise<unknown>) {
	return {
		getProvider: (id: string) => (id === "codex" ? { name: "OpenAI Codex", auth: { oauth: {} } } : undefined),
		login: vi.fn(async (_id: string, _type: string, interaction: Interaction) => behavior(interaction)),
	} as unknown as ModelRuntime & { login: ReturnType<typeof vi.fn> };
}

function makeService(runtime: ModelRuntime) {
	const sent: LoginEventPayload[] = [];
	const service = new LoginService({
		getRuntime: async () => runtime,
		send: (payload) => sent.push(payload),
	});
	return { service, sent };
}

describe("LoginService", () => {
	it("完整流程：auth_url 事件转发 + manual_code 提示应答 + 成功收尾", async () => {
		const runtime = makeRuntime(async (interaction) => {
			interaction.notify({ type: "auth_url" });
			const code = await interaction.prompt({ type: "manual_code", message: "paste code" });
			expect(code).toBe("auth-code-123");
			return { type: "oauth" };
		});
		const { service, sent } = makeService(runtime);

		const promise = service.startLogin("L1", "codex");
		// 等提示事件发出后再应答
		await vi.waitFor(() => {
			expect(sent.some((p) => p.kind === "prompt")).toBe(true);
		});
		const promptPayload = sent.find((p) => p.kind === "prompt");
		if (promptPayload?.kind !== "prompt") throw new Error("unreachable");
		service.respond("L1", promptPayload.promptId, "auth-code-123");

		await expect(promise).resolves.toEqual({ ok: true });
		expect(sent.map((p) => p.kind)).toEqual(["event", "prompt"]);
		expect(runtime.login).toHaveBeenCalledWith("codex", "oauth", expect.objectContaining({}));
	});

	it("prompt.signal 外部取消（浏览器回调先到）：prompt-cancel 事件 + 挂起 promise 被拒", async () => {
		const runtime = makeRuntime(async (interaction) => {
			// 模拟 codex：挂起 manual_code 后浏览器回调先到，SDK abort 该 prompt 的 signal 并 catch
			const controller = new AbortController();
			const pending = interaction
				.prompt({ type: "manual_code", message: "paste", signal: controller.signal })
				.catch(() => "browser-won");
			controller.abort();
			await expect(pending).resolves.toBe("browser-won");
			return { type: "oauth" };
		});
		const { service, sent } = makeService(runtime);

		const result = await service.startLogin("L2", "codex");
		expect(result).toEqual({ ok: true });
		const cancels = sent.filter((p) => p.kind === "prompt-cancel");
		expect(cancels).toHaveLength(1);
	});

	it("用户取消：abort 后返回 cancelled:true 并回收挂起 prompt", async () => {
		const runtime = makeRuntime(async (interaction) => {
			const pending = interaction.prompt({ type: "text", message: "domain?" }).catch((e: Error) => e.message);
			// 等取消信号
			await new Promise<void>((resolve) => {
				if (interaction.signal?.aborted) return resolve();
				interaction.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			await expect(pending).resolves.toBe("Login cancelled");
			throw new Error("Login cancelled");
		});
		const { service, sent } = makeService(runtime);

		const promise = service.startLogin("L3", "codex");
		await vi.waitFor(() => {
			expect(sent.some((p) => p.kind === "prompt")).toBe(true);
		});
		service.cancel("L3");
		await expect(promise).resolves.toMatchObject({ ok: false, cancelled: true });
		expect(sent.filter((p) => p.kind === "prompt-cancel")).toHaveLength(1);
	});

	it("单飞：进行中有登录时第二个 startLogin 直接拒绝", async () => {
		const runtime = makeRuntime(
			(interaction) =>
				new Promise((resolve) => {
					interaction.signal?.addEventListener("abort", () => resolve({ type: "oauth" }), { once: true });
				}),
		);
		const { service } = makeService(runtime);

		const first = service.startLogin("L4", "codex");
		await expect(service.startLogin("L5", "codex")).rejects.toThrow("已有进行中的登录流程");
		service.cancel("L4");
		await first;
	});

	it("未知 promptId / 非当前 loginId 的应答静默忽略", async () => {
		const runtime = makeRuntime(async (interaction) => {
			const value = await interaction.prompt({ type: "text", message: "x" });
			expect(value).toBe("real");
			return { type: "oauth" };
		});
		const { service, sent } = makeService(runtime);

		const promise = service.startLogin("L6", "codex");
		await vi.waitFor(() => {
			expect(sent.some((p) => p.kind === "prompt")).toBe(true);
		});
		service.respond("L6", "bogus", "junk");
		service.respond("OTHER", "L6:1", "junk");
		service.respond("L6", "L6:1", "real");
		await expect(promise).resolves.toEqual({ ok: true });
	});

	it("provider 不支持订阅登录时返回错误结果", async () => {
		const runtime = {
			getProvider: () => ({ name: "DeepSeek", auth: { apiKey: {} } }),
		} as unknown as ModelRuntime;
		const { service } = makeService(runtime);
		await expect(service.startLogin("L7", "deepseek")).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("不支持订阅登录"),
		});
	});

	it("未知 provider 返回错误结果", async () => {
		const runtime = makeRuntime(async () => ({}));
		const { service } = makeService(runtime);
		await expect(service.startLogin("L8", "nope")).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("未知 provider"),
		});
	});
});
