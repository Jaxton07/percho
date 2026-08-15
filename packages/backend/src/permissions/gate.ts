import type { PermissionAnswer, PermissionRequest, PermissionRequestKind } from "@percho/shared";

export type PermissionResponder = (req: PermissionRequest) => void;

/** 权限请求附加元数据（内置权限门控扩展专用；其余扩展 confirm 不带） */
export interface PermissionRequestMeta {
	kind: PermissionRequestKind;
	/** path 类越界时建议加入工作区的根目录（git 根候选） */
	suggestDir?: string;
}

let nextId = 0;

/**
 * 权限确认门控：将 pi 扩展的 uiContext.confirm 桥接为 permission_request 事件。
 * 会话内「总是允许」（同 title 自动通过）+ 项目级持久化（由 PiBackend 落 workspaces.json）。
 */
export class PermissionGate {
	private readonly pending = new Map<
		string,
		{ resolve: (answer: boolean) => void; meta?: PermissionRequestMeta }
	>();
	private readonly titles = new Map<string, string>();
	private readonly alwaysAllowed = new Set<string>();

	private sessionId = "";

	constructor(private readonly onRequest: PermissionResponder) {}

	/** 会话创建后才能确定 sessionId，创建后绑定 */
	bindSession(sessionId: string): void {
		this.sessionId = sessionId;
	}

	/** 实现 ExtensionUIContext.confirm 的语义；meta 由内置权限扩展携带（kind/suggestDir） */
	confirm(title: string, message: string, meta?: PermissionRequestMeta): Promise<boolean> {
		if (this.alwaysAllowed.has(title)) {
			return Promise.resolve(true);
		}
		const id = `perm-${this.sessionId}-${nextId++}`;
		return new Promise<boolean>((resolve) => {
			this.pending.set(id, { resolve, meta });
			this.titles.set(id, title);
			this.onRequest({
				id,
				sessionId: this.sessionId,
				title,
				message,
				kind: meta?.kind ?? "other",
				suggestDir: meta?.suggestDir,
			});
		});
	}

	/** 未决请求信息（PiBackend 处理 allowDir/allowAlways 持久化用） */
	getRequest(requestId: string): { title: string; meta?: PermissionRequestMeta } | undefined {
		if (!this.pending.has(requestId)) return undefined;
		return { title: this.titles.get(requestId) ?? "", meta: this.pending.get(requestId)?.meta };
	}

	/** 请求所属会话（持久化定位项目根用） */
	getSessionId(): string {
		return this.sessionId;
	}

	respond(requestId: string, answer: PermissionAnswer): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		const title = this.titles.get(requestId) ?? "";
		this.pending.delete(requestId);
		this.titles.delete(requestId);
		if (answer === "allowAlways" && title) {
			this.alwaysAllowed.add(title);
		}
		entry.resolve(answer === "allow" || answer === "allowAlways" || answer === "allowDir");
	}

	dispose(): void {
		for (const { resolve } of this.pending.values()) resolve(false);
		this.pending.clear();
		this.titles.clear();
	}
}
