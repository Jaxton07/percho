import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

const base = resolve(import.meta.dirname, "../../../.local/tmp/sdk-upgrade/cache-archive");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
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

async function fixture() {
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "case-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	for (const name of ["home", "agent", "xdg", "tmp", "project"]) await mkdir(join(root, name));
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
	vi.stubEnv("XDG_CACHE_HOME", join(root, "xdg"));
	vi.stubEnv("TMPDIR", join(root, "tmp"));
	const cwd = join(root, "project");
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "persisted conversation", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing session file");
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	cleanups.push(() => backend.dispose());
	const meta = await backend.openSession(file);
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	const entry = registry.get(meta.sessionId);
	if (!entry || entry.readOnly) throw new Error("Missing writable session");
	const { CacheWarmer } = await import(
		pathToFileURL(
			resolve(
				import.meta.dirname,
				"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js",
			),
		).href
	);
	let finish!: () => void;
	const held = new Promise<void>((done) => {
		finish = done;
	});
	let entered!: () => void;
	const started = new Promise<void>((done) => {
		entered = done;
	});
	let signal: AbortSignal | undefined;
	const warmer = new CacheWarmer(
		{
			streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
				signal = options.signal;
				entered();
				return {
					result: async () => {
						await held;
						throw new Error("cancelled test transport");
					},
				};
			},
		},
		entry.session.sessionManager,
		() => "idle",
		async () => "warm",
	);
	// Use the real SDK warmer on a real backend-owned session, injecting only its transport.
	const owner = entry.session as unknown as { _cacheWarmer?: typeof warmer };
	owner._cacheWarmer?.cancel();
	owner._cacheWarmer = warmer;
	cleanups.push(async () => {
		finish();
		warmer.cancel();
		await vi.waitFor(() => expect(warmer.hasPendingWork).toBe(false));
	});
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
	return { backend, meta, file, warmer, finish, started, signal: () => signal };
}

it("refuses archive during a refresh and after cancellation until the real SDK settles", async () => {
	const f = await fixture();
	const input = { sessionId: f.meta.sessionId, sessionFile: f.file, expectedRevision: 0 };
	const bytes = await readFile(f.file);
	await f.started;
	await expect(f.backend.archiveSession(input)).rejects.toThrow(/busy/i);
	expect(await readFile(f.file)).toEqual(bytes);
	f.warmer.cancel();
	expect(f.signal()?.aborted).toBe(true);
	await expect(f.backend.archiveSession(input)).rejects.toThrow(/busy/i);
	expect(await readFile(f.file)).toEqual(bytes);
	f.finish();
	await vi.waitFor(() => expect(f.warmer.hasPendingWork).toBe(false));
	await expect(f.backend.archiveSession(input)).resolves.toMatchObject({ archived: true });
});

it("ordinary close cancels the real in-flight warming transport without leaking it", async () => {
	const f = await fixture();
	await f.started;
	await expect(f.backend.closeSession(f.meta.sessionId)).resolves.toEqual({ closed: true });
	expect(f.signal()?.aborted).toBe(true);
	f.finish();
	await vi.waitFor(() => expect(f.warmer.hasPendingWork).toBe(false));
	expect(f.backend.getLoadedSessions().some((row) => row.meta.sessionId === f.meta.sessionId)).toBe(false);
});
