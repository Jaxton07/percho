import type {
	ExtensionDialogKind,
	ExtensionDialogRequest,
	ExtensionDialogResolved,
	ExtensionDialogRespond,
} from "@percho/shared";

/** 请求分发回调（PiBackend 注入 → IPC → renderer 停靠槽），仿 PermissionGate responder */
export type ExtensionDialogResponder = (req: ExtensionDialogRequest) => void;
/** 结算回调（PiBackend 注入 → IPC resolved 事件，renderer 撤卡；应答/超时/中止/关闭都广播） */
export type ExtensionDialogResolvedListener = (result: ExtensionDialogResolved) => void;

/** ask 的业务字段（kind 由方法参数给出；title 插件原文，宿主不改写） */
export interface ExtensionDialogFields {
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
}

/** 对齐 SDK ExtensionUIDialogOptions（types.d.ts） */
export interface ExtensionDialogOpts {
	signal?: AbortSignal;
	timeout?: number;
}

/** 各 kind 的契约取消值（spec D3 诚实取消：永不伪造「第一项/空串」当用户输入） */
const CANCEL_VALUE: Record<ExtensionDialogKind, string | boolean | undefined> = {
	select: undefined,
	input: undefined,
	editor: undefined,
	confirm: false,
};

interface PendingEntry {
	request: ExtensionDialogRequest;
	resolve: (value: string | boolean | undefined) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
	/** 幂等闸：应答/超时/abort/关闭竞态只取第一个 */
	settled: boolean;
}

/**
 * 扩展对话框宿主：每会话一个（与 PermissionGate 平行）。职责：
 * - ask() 注册 pending（分配 dlg-<sessionId>-<n>）并 dispatch 请求事件；
 * - timeout 起定时器、signal 监听 abort，到点/中止自动按取消值结算（D4：裁决在 backend）；
 * - respond() 用户应答结算；dispose() 会话关闭兜底（防扩展 Promise 悬挂卡死 agent）。
 * 纯逻辑、零 Electron 依赖；回调注入。
 */
export class ExtensionDialogHost {
	private readonly pending = new Map<string, PendingEntry>();
	private sessionId = "";
	private seq = 0;

	constructor(
		private readonly listeners: {
			onRequest: ExtensionDialogResponder;
			onResolved: ExtensionDialogResolvedListener;
		},
	) {}

	/** 会话创建后才能确定 sessionId，创建后绑定（仿 gate.bindSession 两步构造） */
	bind(sessionId: string): void {
		this.sessionId = sessionId;
	}

	/** 实现 ctx.ui.select/confirm/input/editor 的统一入口；取消值按 kind 契约 */
	ask(
		kind: ExtensionDialogKind,
		fields: ExtensionDialogFields,
		opts?: ExtensionDialogOpts,
	): Promise<string | boolean | undefined> {
		const id = `dlg-${this.sessionId}-${this.seq++}`;
		const request: ExtensionDialogRequest = {
			id,
			sessionId: this.sessionId,
			kind,
			title: fields.title,
			...(fields.message !== undefined ? { message: fields.message } : {}),
			...(fields.options !== undefined ? { options: fields.options } : {}),
			...(fields.placeholder !== undefined ? { placeholder: fields.placeholder } : {}),
			...(fields.prefill !== undefined ? { prefill: fields.prefill } : {}),
			...(opts?.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
			requestedAt: Date.now(),
		};
		// 请求到达前已中止：不 dispatch，直接按取消结算（诚实取消，fail-closed）
		if (opts?.signal?.aborted) {
			this.listeners.onResolved({ sessionId: this.sessionId, requestId: id, reason: "aborted" });
			return Promise.resolve(CANCEL_VALUE[kind]);
		}
		return new Promise((resolve) => {
			const entry: PendingEntry = {
				request,
				resolve,
				timer: undefined,
				signal: opts?.signal,
				onAbort: undefined,
				settled: false,
			};
			if (opts?.timeout !== undefined && opts.timeout > 0) {
				entry.timer = setTimeout(() => this.settle(id, "timeout"), opts.timeout);
			}
			if (opts?.signal) {
				entry.onAbort = () => this.settle(id, "aborted");
				opts.signal.addEventListener("abort", entry.onAbort, { once: true });
			}
			this.pending.set(id, entry);
			this.listeners.onRequest(request);
		});
	}

	/** 用户应答（renderer IPC；confirm 的 confirmed !== true 一律 false，fail-closed） */
	respond(requestId: string, answer: ExtensionDialogRespond): void {
		const entry = this.pending.get(requestId);
		if (!entry || entry.settled) return;
		if ("cancelled" in answer) {
			this.settle(requestId, "answered");
			return;
		}
		if (entry.request.kind === "confirm") {
			this.settle(requestId, "answered", "confirmed" in answer && answer.confirmed === true);
		} else {
			this.settle(
				requestId,
				"answered",
				"value" in answer && typeof answer.value === "string"
					? answer.value
					: CANCEL_VALUE[entry.request.kind],
			);
		}
	}

	/** 会话关闭兜底：全部按 sessionClosed 结算（扩展 Promise 落取消值，agent 不悬挂） */
	dispose(): void {
		for (const id of [...this.pending.keys()]) this.settle(id, "sessionClosed");
	}

	/** 统一结算出口：resolve + 广播 resolved；重复 settle 幂等 */
	private settle(
		requestId: string,
		reason: ExtensionDialogResolved["reason"],
		value?: string | boolean,
	): void {
		const entry = this.pending.get(requestId);
		if (!entry || entry.settled) return;
		entry.settled = true;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
		this.pending.delete(requestId);
		entry.resolve(value !== undefined ? value : CANCEL_VALUE[entry.request.kind]);
		this.listeners.onResolved({
			sessionId: entry.request.sessionId,
			requestId,
			reason,
		});
	}
}
