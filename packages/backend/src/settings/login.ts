import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LoginAuthEvent, LoginAuthPrompt, LoginEventPayload, LoginResult } from "@percho/shared";

/**
 * SDK AuthInteraction.prompt 的入参结构（pi-ai 未通过公开导出暴露 AuthPrompt 类型，
 * 这里用 LoginAuthPrompt + 本地 signal 做结构子集；runtime.login 形参是结构校验，可正常传入）。
 */
type InteractionPrompt = LoginAuthPrompt & { signal?: AbortSignal };

interface PendingPrompt {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
}

interface ActiveLogin {
	loginId: string;
	providerId: string;
	abort: AbortController;
	/** promptId → 挂起的应答（renderer respondProviderLogin 解除） */
	prompts: Map<string, PendingPrompt>;
	promptSeq: number;
}

export interface LoginServiceDeps {
	getRuntime: () => Promise<ModelRuntime>;
	/** 登录事件转发（main 侧接到 settings:loginEvent 通道推给 renderer） */
	send: (payload: LoginEventPayload) => void;
}

/**
 * Provider 订阅登录（OAuth）服务：把 pi SDK 的 AuthInteraction 桥接成 IPC 事件。
 * 同一时刻只允许一个登录流程（UI 为模态对话框）；
 * 浏览器回调先完成时 SDK 会 abort 挂起 prompt 的 signal（外部取消），
 * 整体取消/流程结束时回收全部挂起 prompt，防 Promise 泄漏。
 */
export class LoginService {
	private active: ActiveLogin | undefined;

	constructor(private readonly deps: LoginServiceDeps) {}

	async startLogin(loginId: string, providerId: string): Promise<LoginResult> {
		if (!loginId) throw new Error("loginId 不能为空");
		// check-then-set 必须原子：先占位再 await（getRuntime 是异步的，先 await 会让并发调用双双穿过守卫）
		if (this.active) throw new Error("已有进行中的登录流程");
		const login: ActiveLogin = {
			loginId,
			providerId,
			abort: new AbortController(),
			prompts: new Map(),
			promptSeq: 0,
		};
		this.active = login;

		try {
			const runtime = await this.deps.getRuntime();
			const provider = runtime.getProvider(providerId);
			if (!provider) throw new Error(`未知 provider：${providerId}`);
			if (!provider.auth.oauth) throw new Error(`${provider.name || providerId} 不支持订阅登录`);
			// 凭证持久化由 SDK models.login 内部完成（auth.json + 运行时可用性同步）
			await runtime.login(providerId, "oauth", {
				signal: login.abort.signal,
				notify: (event) => this.notify(login, event),
				prompt: (prompt) => this.prompt(login, prompt),
			});
			return { ok: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const cancelled = login.abort.signal.aborted || message === "Login cancelled";
			return { ok: false, cancelled, error: message };
		} finally {
			this.settle(login);
		}
	}

	/** renderer 应答提示；promptId 已被外部取消（浏览器回调先到）时静默忽略 */
	respond(loginId: string, promptId: string, value: string): void {
		const login = this.active;
		if (!login || login.loginId !== loginId) return;
		const pending = login.prompts.get(promptId);
		if (!pending) return;
		login.prompts.delete(promptId);
		pending.resolve(value);
	}

	/** 取消进行中的登录流程（未知 loginId 静默忽略） */
	cancel(loginId: string): void {
		if (this.active?.loginId === loginId) this.active.abort.abort();
	}

	private notify(login: ActiveLogin, event: LoginAuthEvent): void {
		this.deps.send({ loginId: login.loginId, kind: "event", event });
	}

	private prompt(login: ActiveLogin, prompt: InteractionPrompt): Promise<string> {
		const promptId = `${login.loginId}:${++login.promptSeq}`;
		// signal 是 AbortSignal 不可结构化克隆，剥离后跨进程发送；取消经 prompt-cancel 事件表达
		const wire: LoginAuthPrompt =
			prompt.type === "select"
				? { type: "select", message: prompt.message, options: prompt.options }
				: { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder };
		this.deps.send({ loginId: login.loginId, kind: "prompt", promptId, prompt: wire });

		return new Promise<string>((resolve, reject) => {
			login.prompts.set(promptId, { resolve, reject });
			const onAbort = () => {
				if (!login.prompts.delete(promptId)) return;
				this.deps.send({ loginId: login.loginId, kind: "prompt-cancel", promptId });
				reject(new Error("Login cancelled"));
			};
			// prompt.signal：浏览器回调先完成时 SDK 外部取消挂起的手动输入（如 codex/anthropic）
			if (prompt.signal) {
				if (prompt.signal.aborted) onAbort();
				else prompt.signal.addEventListener("abort", onAbort, { once: true });
			}
			// 整体取消：SDK race 会拒掉 login 本体，这里同步拒掉挂起 prompt 防泄漏
			if (login.abort.signal.aborted) onAbort();
			else login.abort.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** 流程结束回收：防御性拒掉仍挂起的 prompt（正常完成时列表已为空） */
	private settle(login: ActiveLogin): void {
		if (this.active === login) this.active = undefined;
		login.abort.abort();
		for (const [promptId, pending] of login.prompts) {
			this.deps.send({ loginId: login.loginId, kind: "prompt-cancel", promptId });
			pending.reject(new Error("Login cancelled"));
		}
		login.prompts.clear();
	}
}
