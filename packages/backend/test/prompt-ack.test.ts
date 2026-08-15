import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

interface PromptOptions {
	preflightResult?: (ok: boolean) => void;
}
type PromptFn = (text: string, options?: PromptOptions) => Promise<void>;

/** 注入 stub session 到私有 registry（prompt 路径不触网/不依赖 SDK） */
function makeBackend(sessionId: string, prompt: PromptFn): PiBackend {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session: { sessionId, prompt } as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: "/tmp",
	});
	return backend;
}

describe("PiBackend.prompt 受理回执", () => {
	it("preflight ack 后立即返回，不等 run 结束", async () => {
		let releaseRun!: () => void;
		const runGate = new Promise<void>((r) => {
			releaseRun = r;
		});
		const backend = makeBackend("s1", (_text, options) => {
			options?.preflightResult?.(true);
			return runGate; // run 永不结束也不影响返回
		});

		await expect(backend.prompt("s1", "hi")).resolves.toBeUndefined();
		releaseRun();
	});

	it("无 preflight 直接返回（SDK if (!messages) return 保险路径）也放行", async () => {
		const backend = makeBackend("s1", async () => {});
		await expect(backend.prompt("s1", "hi")).resolves.toBeUndefined();
	});

	it("preflight 前抛错：reject 传真实错误（非泛化 preflight 文案）", async () => {
		const backend = makeBackend("s1", async (_text, options) => {
			options?.preflightResult?.(false); // SDK 顺序：先 preflight(false) 再 throw
			throw new Error("Authentication failed for provider");
		});

		await expect(backend.prompt("s1", "hi")).rejects.toThrow("Authentication failed for provider");
	});

	it("ack 之后 run 期失败不回传、无 unhandled rejection", async () => {
		const backend = makeBackend("s1", (_text, options) => {
			options?.preflightResult?.(true);
			return Promise.reject(new Error("run failed"));
		});

		await expect(backend.prompt("s1", "hi")).resolves.toBeUndefined();
	});

	it("无会话直接抛错", async () => {
		const backend = makeBackend("s1", async () => {});
		await expect(backend.prompt("missing", "hi")).rejects.toThrow();
	});
});
