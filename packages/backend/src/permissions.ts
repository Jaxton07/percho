import type { PermissionAnswer, PermissionRequest } from "@pi-desktop/shared";

export type PermissionResponder = (req: PermissionRequest) => void;

let nextId = 0;

/**
 * 权限确认门控：将 pi 扩展的 uiContext.confirm 桥接为 permission_request 事件。
 * 支持「本会话总是允许」：同一 title 后续自动通过。
 */
export class PermissionGate {
	private readonly pending = new Map<string, (answer: boolean) => void>();
	private readonly titles = new Map<string, string>();
	private readonly alwaysAllowed = new Set<string>();

	private sessionId = "";

	constructor(private readonly onRequest: PermissionResponder) {}

	/** 会话创建后才能确定 sessionId，创建后绑定 */
	bindSession(sessionId: string): void {
		this.sessionId = sessionId;
	}

	/** 实现 ExtensionUIContext.confirm 的语义 */
	confirm(title: string, message: string): Promise<boolean> {
		if (this.alwaysAllowed.has(title)) {
			return Promise.resolve(true);
		}
		const id = `perm-${this.sessionId}-${nextId++}`;
		return new Promise<boolean>((resolve) => {
			this.pending.set(id, resolve);
			this.titles.set(id, title);
			this.onRequest({ id, sessionId: this.sessionId, title, message });
		});
	}

	respond(requestId: string, answer: PermissionAnswer): void {
		const resolve = this.pending.get(requestId);
		if (!resolve) return;
		this.pending.delete(requestId);
		const title = this.titles.get(requestId);
		this.titles.delete(requestId);
		if (answer === "allowAlways" && title) {
			this.alwaysAllowed.add(title);
		}
		resolve(answer === "allow" || answer === "allowAlways");
	}

	dispose(): void {
		for (const resolve of this.pending.values()) resolve(false);
		this.pending.clear();
		this.titles.clear();
	}
}
