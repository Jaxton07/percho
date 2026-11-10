import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

const base = resolve(import.meta.dirname, "../../../.local/tmp/sdk-upgrade/gc-close");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

async function fixture() {
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "case-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	for (const name of ["home", "agent", "xdg", "tmp", "project"]) await mkdir(join(root, name));
	for (const [key, name] of Object.entries({
		HOME: "home",
		PI_CODING_AGENT_DIR: "agent",
		XDG_CONFIG_HOME: "xdg",
		XDG_CACHE_HOME: "xdg",
		TMPDIR: "tmp",
	}))
		vi.stubEnv(key, join(root, name));
	const manager = SessionManager.create(join(root, "project"));
	manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (!file) throw new Error("missing session file");
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	cleanups.push(() => backend.dispose());
	const meta = await backend.openSession(file);
	const entry = (backend as unknown as { registry: SessionRegistry }).registry.get(meta.sessionId);
	if (!entry || entry.readOnly) throw new Error("missing session");
	return { backend, session: entry.session, id: meta.sessionId };
}

it("GC refuses pending real SDK cache warming and closes after settlement", async () => {
	const f = await fixture();
	const { CacheWarmer } = await import(
		pathToFileURL(
			resolve(
				import.meta.dirname,
				"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js",
			),
		).href
	);
	let finish!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let signal: AbortSignal | undefined;
	const warmer = new CacheWarmer(
		{
			streamSimple: (_m: unknown, _c: unknown, options: { signal: AbortSignal }) => {
				signal = options.signal;
				entered();
				return {
					result: async () => {
						await held;
						throw new Error("test transport");
					},
				};
			},
		},
		f.session.sessionManager,
		() => "idle",
		async () => "warm",
	);
	const owner = f.session as unknown as { _cacheWarmer?: typeof warmer };
	owner._cacheWarmer?.cancel();
	owner._cacheWarmer = warmer;
	cleanups.push(async () => {
		finish();
		warmer.cancel();
		await vi.waitFor(() => expect(warmer.hasPendingWork).toBe(false));
	});
	const model: Model<"openai-completions"> = {
		id: "test",
		name: "test",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		input: ["text"],
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	vi.useFakeTimers();
	try {
		warmer.start(
			{ model: { ...model, promptCache: { short: 100 } }, context: { messages: [] }, options: {} },
			() => true,
		);
		await vi.advanceTimersToNextTimerAsync();
	} finally {
		vi.useRealTimers();
	}
	await started;
	await expect(f.backend.closeSession(f.id, "gc")).resolves.toEqual({ closed: false });
	expect(signal?.aborted).toBe(false);
	warmer.cancel();
	finish();
	await vi.waitFor(() => expect(warmer.hasPendingWork).toBe(false));
	await expect(f.backend.closeSession(f.id, "gc")).resolves.toEqual({ closed: true });
});

it("holds the real idle lease across shutdown and rejects a late prompt", async () => {
	const f = await fixture();
	let finish!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const runner = f.session.extensionRunner;
	const emit = runner.emit.bind(runner);
	vi.spyOn(runner, "emit").mockImplementation(async (event) => {
		if (event.type === "session_shutdown") {
			entered();
			await held;
		}
		return emit(event);
	});
	const closing = f.backend.closeSession(f.id, "gc");
	try {
		await started;
		await expect(f.session.prompt("late")).rejects.toThrow(/idle lease/i);
	} finally {
		finish();
		await closing;
	}
	expect(f.backend.getLoadedSessions().some((row) => row.meta.sessionId === f.id)).toBe(false);
});
