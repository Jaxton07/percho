import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionConfig,
	ExtensionAPI,
	InlineExtension,
	SessionIdleLease,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { emitSessionShutdown } from "../src/session/shutdown";

let sdk: typeof import("@earendil-works/pi-coding-agent");
let ai: typeof import("@earendil-works/pi-ai");
let root: string;
const sessions: AgentSession[] = [];
const releases: Array<() => void> = [];
const model: Model<"openai-completions"> = {
	id: "idle-lease-test",
	name: "idle-lease-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}

beforeAll(async () => {
	const base = resolve(import.meta.dirname, "../../../.local/tmp/session-archive-catalog/ticket01");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "test-"));
	for (const name of ["home", "agent", "xdg", "tmp"]) mkdirSync(join(root, name));
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
	vi.stubEnv("XDG_CACHE_HOME", join(root, "xdg"));
	vi.stubEnv("TMPDIR", join(root, "tmp"));
	sdk = await import("@earendil-works/pi-coding-agent");
	ai = await import("@earendil-works/pi-ai");
});

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const session of sessions.splice(0)) {
		await session.abort();
		session.dispose();
	}
});

afterAll(() => {
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
});

async function fixture(
	extension?: InlineExtension,
	bind = true,
	cacheWarming: "off" | "streaming" | "idle" = "off",
) {
	const cwd = mkdtempSync(join(root, "project-"));
	let api!: ExtensionAPI;
	const errors: string[] = [];
	const settingsManager = sdk.SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming,
	});
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			(pi) => {
				api = pi;
				return extension?.(pi);
			},
		],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(cwd, "model-cache.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "isolated-test-key",
		models: [model],
	});
	const { session } = await sdk.createAgentSession({
		cwd,
		agentDir: join(root, "agent"),
		model,
		settingsManager,
		resourceLoader,
		noTools: "all",
		sessionManager: sdk.SessionManager.create(cwd, join(cwd, "sessions")),
		modelRuntime,
	});
	sessions.push(session);
	let requests = 0;
	let nextRequest: ReturnType<typeof barrier> | undefined;
	let requestStarted: ReturnType<typeof barrier> | undefined;
	session.agent.streamFunction = async () => {
		requests++;
		const held = nextRequest;
		nextRequest = undefined;
		requestStarted?.resolve();
		if (held) await held.promise;
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const stream = ai.createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	const bindExtensions = () =>
		session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.event) });
	if (bind) await bindExtensions();
	return {
		session,
		api,
		cwd,
		errors,
		bindExtensions,
		requests: () => requests,
		holdNextRequest: () => {
			nextRequest = barrier();
			requestStarted = barrier();
			return { release: nextRequest.resolve, started: requestStarted.promise };
		},
	};
}

function acquire(session: AgentSession): SessionIdleLease {
	const lease = session.tryAcquireIdleLease();
	expect(lease).toBeDefined();
	return lease as SessionIdleLease;
}

describe("SDK exclusive idle maintenance", () => {
	it("is exclusive, releases idempotently, and old tokens cannot unlock a new lease", async () => {
		const { session } = await fixture();
		const old = acquire(session);
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		old.release();
		old.release();
		const current = acquire(session);
		old.release();
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		expect(() => old.appendCustomEntry("stale", {})).toThrow(/no longer active/);
		current.release();
		await session.prompt("works after release");
	});

	it("does not mistake a pending nextTurn message for an idle session or discard it", async () => {
		const { session, requests } = await fixture();
		await session.sendCustomMessage(
			{ customType: "aside", content: "keep", display: true },
			{ deliverAs: "nextTurn" },
		);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.isIdle).toBe(true);
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		await session.prompt("consume aside");
		expect(session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ customType: "aside" }),
		);
		expect(requests()).toBe(1);
		acquire(session).release();
	});

	it("refuses while input and startup hooks own accepted work", async () => {
		const startup = barrier();
		const startupEntered = barrier();
		const input = barrier();
		const inputEntered = barrier();
		const f = await fixture((pi) => {
			pi.on("session_start", async () => {
				startupEntered.resolve();
				await startup.promise;
			});
			pi.on("input", async () => {
				inputEntered.resolve();
				await input.promise;
				return { action: "continue" };
			});
		}, false);
		const binding = f.bindExtensions();
		await startupEntered.promise;
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		startup.resolve();
		await binding;
		const prompt = f.session.prompt("held input");
		await inputEntered.promise;
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		input.resolve();
		await prompt;
		acquire(f.session).release();
	});

	it("preserves queued and context-only messages while a request is in flight", async () => {
		const f = await fixture();
		const held = f.holdNextRequest();
		const running = f.session.prompt("running");
		await held.started;
		await f.session.sendCustomMessage({ customType: "context-only", content: "keep", display: true });
		await f.session.followUp("also keep");
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		held.release();
		await running;
		expect(f.session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ customType: "context-only" }),
		);
		expect(f.session.messages).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "also keep" })]),
			}),
		);
	});

	it("keeps settled callbacks and their deferred messages protected until completed", async () => {
		const entered = barrier();
		const finish = barrier();
		let first = true;
		const f = await fixture((pi) => {
			pi.on("agent_settled", async () => {
				if (!first) return;
				first = false;
				pi.sendUserMessage("deferred user");
				entered.resolve();
				await finish.promise;
			});
		});
		const prompt = f.session.prompt("trigger settled");
		await entered.promise;
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		finish.resolve();
		await prompt;
		expect(f.requests()).toBe(2);
		acquire(f.session).release();
	});

	it("rejects all public mutation families while held, before any side effects", async () => {
		const f = await fixture();
		await f.session.prompt("persist initial conversation");
		const before = f.session.sessionManager.getEntries();
		const lease = acquire(f.session);
		for (const operation of [
			() => f.session.prompt("blocked"),
			() => f.session.sendUserMessage("blocked"),
			() => f.session.sendCustomMessage({ customType: "blocked", content: "x", display: true }),
			() => f.session.steer("blocked"),
			() => f.session.followUp("blocked"),
			() => f.session.compact(),
			() => f.session.bindExtensions({ mode: "rpc" }),
			() => f.session.reload(),
			() => f.session.navigateTree("missing"),
			() => f.session.setModel(model),
			() => f.session.cycleModel(),
			() => f.session.executeBash("printf should-not-run"),
		])
			await expect(operation()).rejects.toThrow(/idle lease/);
		for (const operation of [
			() => f.session.clearQueue(),
			() => f.session.setSessionName("blocked"),
			() => f.session.setThinkingLevel("off"),
			() => f.session.setActiveToolsByName([]),
			() => f.session.refreshContext(),
			() => f.session.setAutoRetryEnabled(true),
			() => f.session.setAutoCompactionEnabled(true),
			() => f.session.setCacheWarmingMode("off"),
			() => f.api.appendEntry("blocked", {}),
			() => f.api.setLabel(before[0].id, "blocked"),
		])
			expect(operation).toThrow(/idle lease/);
		expect(f.session.sessionManager.getEntries()).toEqual(before);
		expect(f.requests()).toBe(1);
		lease.release();
	});

	it("reports rejected delayed extension messages through the real runner", async () => {
		const f = await fixture();
		const before = f.session.sessionManager.getEntries();
		const lease = acquire(f.session);
		f.api.sendUserMessage("late user");
		f.api.sendMessage({ customType: "late", content: "late custom", display: true });
		await vi.waitFor(() => expect(f.errors.sort()).toEqual(["send_message", "send_user_message"]));
		expect(f.session.sessionManager.getEntries()).toEqual(before);
		expect(f.requests()).toBe(0);
		lease.release();
	});

	it("tracks an accepted bash command until its result is recorded", async () => {
		const f = await fixture();
		const observed: Array<SessionIdleLease | undefined> = [];
		await f.session.executeBash("printf idle-lease-marker", () =>
			observed.push(f.session.tryAcquireIdleLease()),
		);
		expect(observed.length).toBeGreaterThan(0);
		expect(observed.every((lease) => lease === undefined)).toBe(true);
		acquire(f.session).release();
	});

	it("does not report successful persistent maintenance on a conversation with no disk history", async () => {
		const f = await fixture();
		const lease = acquire(f.session);
		expect(() => lease.appendCustomEntry("not-persisted", {})).toThrow(/persisted conversation/);
		expect(f.session.sessionManager.getEntries()).not.toContainEqual(
			expect.objectContaining({ customType: "not-persisted" }),
		);
		lease.release();
	});

	it("keeps maintenance event reentry protected even if a listener releases the token", async () => {
		const f = await fixture();
		await f.session.prompt("persist history");
		const lease = acquire(f.session);
		const observed: Array<SessionIdleLease | undefined> = [];
		const unsubscribe = f.session.subscribe((event) => {
			if (event.type !== "entry_appended") return;
			lease.release();
			observed.push(f.session.tryAcquireIdleLease());
		});
		lease.appendCustomEntry("maintenance", {});
		expect(observed).toEqual([undefined]);
		unsubscribe();
		acquire(f.session).release();
	});

	it("persists authorized maintenance entries and emits their normal SDK event", async () => {
		const f = await fixture();
		await f.session.prompt("create disk history");
		const observed: string[] = [];
		const unsubscribe = f.session.subscribe((event) => {
			if (event.type === "entry_appended") observed.push(event.entry.id);
		});
		const lease = acquire(f.session);
		const id = lease.appendCustomEntry("maintenance", { topics: [] });
		expect(observed).toContain(id);
		const reopened = sdk.SessionManager.open(f.session.sessionFile as string);
		expect(reopened.getEntry(id)).toMatchObject({
			type: "custom",
			customType: "maintenance",
			data: { topics: [] },
		});
		unsubscribe();
		lease.release();
	});

	it("does not swallow a maintenance disk error or treat contaminated memory as disk success", async () => {
		const f = await fixture();
		await f.session.prompt("create disk history");
		const path = f.session.sessionFile as string;
		const backup = `${path}.backup`;
		const lease = acquire(f.session);
		renameSync(path, backup);
		mkdirSync(path);
		try {
			expect(() => lease.appendCustomEntry("failed", { topics: [] })).toThrow();
		} finally {
			rmSync(path, { recursive: true });
			renameSync(backup, path);
			lease.release();
		}
		expect(sdk.SessionManager.open(path).getEntries()).not.toContainEqual(
			expect.objectContaining({ customType: "failed" }),
		);
	});

	it("does not recreate a missing history file from a stale in-memory conversation", async () => {
		const f = await fixture();
		await f.session.prompt("persist history");
		const path = f.session.sessionFile as string;
		const backup = `${path}.backup`;
		const lease = acquire(f.session);
		renameSync(path, backup);
		try {
			expect(() => lease.appendCustomEntry("must-not-recreate", {})).toThrow();
			expect(existsSync(path)).toBe(false);
		} finally {
			renameSync(backup, path);
			lease.release();
		}
		expect(sdk.SessionManager.open(path).getEntries()).not.toContainEqual(
			expect.objectContaining({ customType: "must-not-recreate" }),
		);
	});

	it("invalidates a held token on disposal while allowing necessary cleanup", async () => {
		const f = await fixture();
		const lease = acquire(f.session);
		f.session.dispose();
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		expect(() => lease.appendCustomEntry("stale", {})).toThrow(/no longer active/);
		expect(() => lease.release()).not.toThrow();
		await expect(f.session.prompt("disposed")).rejects.toThrow(/disposed/);
	});

	it.each(["streaming", "idle"] as const)(
		"allows an idle lease with %s configured but no pending work",
		async (mode) => {
			const f = await fixture(undefined, true, mode);
			expect(f.session.cacheWarmingStatus?.state).toBe("inactive");
			acquire(f.session).release();
		},
	);

	it("keeps a cancelled but unfinished warming decision busy until it settles", async () => {
		const f = await fixture();
		f.session.dispose();
		// CacheWarmer is a public SDK subsystem used by AgentSessionConfig, not a root runtime export.
		const { CacheWarmer } = await import(
			pathToFileURL(
				resolve(
					import.meta.dirname,
					"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js",
				),
			).href
		);
		const entered = barrier();
		const finish = barrier();
		const warmer: NonNullable<AgentSessionConfig["cacheWarmer"]> = new CacheWarmer(
			{
				streamSimple: () => {
					throw new Error("Warming must stop before the transport");
				},
			},
			f.session.sessionManager,
			() => "idle",
			async () => {
				entered.resolve();
				await finish.promise;
				return "stop";
			},
		);
		const session = new sdk.AgentSession({
			agent: f.session.agent,
			sessionManager: f.session.sessionManager,
			settingsManager: f.session.settingsManager,
			resourceLoader: f.session.resourceLoader,
			modelRuntime: f.session.modelRuntime,
			cwd: f.cwd,
			cacheWarmer: warmer,
		});
		sessions.push(session);
		vi.useFakeTimers();
		try {
			warmer.start(
				{
					model: { ...model, promptCache: { short: 100 } },
					context: { messages: [] },
					options: {},
				},
				() => true,
			);
			expect(session.tryAcquireIdleLease()).toBeUndefined();
			await vi.advanceTimersToNextTimerAsync();
			await entered.promise;
			warmer.cancel();
			expect(session.cacheWarmingStatus?.state).toBe("inactive");
			expect(session.tryAcquireIdleLease()).toBeUndefined();
			finish.resolve();
			await vi.advanceTimersByTimeAsync(0);
			acquire(session).release();
			warmer.start(
				{ model: { ...model, promptCache: { short: 100 } }, context: { messages: [] }, options: {} },
				() => true,
			);
			vi.setSystemTime(Date.now() + 60 * 60 * 1000);
			await vi.advanceTimersToNextTimerAsync();
			expect(session.cacheWarmingStatus?.state).toBe("inactive");
			acquire(session).release();
		} finally {
			finish.resolve();
			warmer.cancel();
			vi.useRealTimers();
		}
	});

	it("keeps a cancelled in-flight cache refresh busy until transport settles", async () => {
		const f = await fixture();
		f.session.dispose();
		const { CacheWarmer } = await import(
			pathToFileURL(
				resolve(
					import.meta.dirname,
					"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js",
				),
			).href
		);
		const entered = barrier();
		const finish = barrier();
		const warmer: NonNullable<AgentSessionConfig["cacheWarmer"]> = new CacheWarmer(
			{
				streamSimple: () => ({
					result: async () => {
						entered.resolve();
						await finish.promise;
						throw new Error("cancelled");
					},
				}),
			},
			f.session.sessionManager,
			() => "idle",
			async () => "warm",
		);
		const session = new sdk.AgentSession({
			agent: f.session.agent,
			sessionManager: f.session.sessionManager,
			settingsManager: f.session.settingsManager,
			resourceLoader: f.session.resourceLoader,
			modelRuntime: f.session.modelRuntime,
			cwd: f.cwd,
			cacheWarmer: warmer,
		});
		sessions.push(session);
		vi.useFakeTimers();
		try {
			warmer.start(
				{ model: { ...model, promptCache: { short: 100 } }, context: { messages: [] }, options: {} },
				() => true,
			);
			await vi.advanceTimersToNextTimerAsync();
			await entered.promise;
			warmer.cancel();
			expect(session.cacheWarmingStatus?.state).toBe("inactive");
			expect(session.tryAcquireIdleLease()).toBeUndefined();
			finish.resolve();
			await vi.advanceTimersByTimeAsync(0);
			acquire(session).release();
		} finally {
			finish.resolve();
			warmer.cancel();
			vi.useRealTimers();
		}
	});

	it("rejects a busy reload without shutting down the running extension", async () => {
		let shutdowns = 0;
		const f = await fixture((pi) => {
			pi.on("session_shutdown", () => {
				shutdowns++;
			});
		});
		const held = f.holdNextRequest();
		const running = f.session.prompt("running");
		try {
			await held.started;
			await expect(f.session.reload()).rejects.toThrow();
			expect(shutdowns).toBe(0);
		} finally {
			held.release();
			await running;
		}
	});

	it("awaits real SDK shutdown handlers before disposal", async () => {
		const entered = barrier();
		const finish = barrier();
		const f = await fixture((pi) => {
			pi.on("session_shutdown", async () => {
				entered.resolve();
				await finish.promise;
			});
		});
		const shutdown = emitSessionShutdown(f.session);
		await entered.promise;
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		finish.resolve();
		await shutdown;
		f.session.dispose();
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		await expect(f.session.prompt("closed")).rejects.toThrow(/disposed/);
	});

	it("rejects extension registrations before mutating their registries", async () => {
		const f = await fixture();
		const lease = acquire(f.session);
		expect(() =>
			f.api.registerTool({
				name: "blocked-tool",
				label: "blocked-tool",
				description: "must not be registered",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
			}),
		).toThrow(/idle lease/);
		expect(() => f.api.registerCommand("blocked-command", { handler: async () => {} })).toThrow(/idle lease/);
		expect(() => f.api.registerFlag("blocked-flag", { type: "boolean" })).toThrow(/idle lease/);
		expect(() => f.api.on("input", async () => ({ action: "continue" }))).toThrow(/idle lease/);
		expect(() => f.api.registerProvider("blocked-provider", { baseUrl: "https://example.invalid" })).toThrow(
			/idle lease/,
		);
		lease.release();
		expect(f.api.getAllTools().map((tool) => tool.name)).not.toContain("blocked-tool");
		expect(f.api.getCommands().map((command) => command.name)).not.toContain("blocked-command");
		expect(f.api.getFlag("blocked-flag")).toBeUndefined();
	});

	it("refuses a lease until an accepted extension subprocess has exited", async () => {
		const f = await fixture();
		const ready = join(f.cwd, "ready");
		const done = join(f.cwd, "done");
		const running = f.api.exec(
			process.execPath,
			[
				"-e",
				"const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t)}},5)",
				ready,
				done,
			],
			{ timeout: 2000 },
		);
		try {
			await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
			expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		} finally {
			const { writeFileSync } = await import("node:fs");
			writeFileSync(done, "done");
			await running;
		}
		acquire(f.session).release();
	});

	it("counts externally dispatched extension handlers as in-flight work", async () => {
		const entered = barrier();
		const finish = barrier();
		let hold = false;
		const f = await fixture((pi) => {
			pi.on("session_start", async () => {
				if (!hold) return;
				entered.resolve();
				await finish.promise;
			});
		});
		hold = true;
		const runner = f.session.extensionRunner;
		if (!runner) throw new Error("Fixture must bind a real extension runner");
		const running = runner.emit({ type: "session_start", reason: "reload" });
		await entered.promise;
		expect(f.session.tryAcquireIdleLease()).toBeUndefined();
		finish.resolve();
		await running;
		const lease = acquire(f.session);
		await expect(runner.emit({ type: "session_start", reason: "reload" })).rejects.toThrow(/idle lease/);
		lease.release();
	});

	it("permits shutdown and removing handlers while held without permitting new subscriptions", async () => {
		let unsubscribe = () => {};
		let closed = 0;
		const f = await fixture((pi) => {
			unsubscribe = pi.on("input", () => ({ action: "continue" }));
			pi.on("session_shutdown", () => {
				closed++;
			});
		});
		const lease = acquire(f.session);
		expect(() => unsubscribe()).not.toThrow();
		expect(() => unsubscribe()).not.toThrow();
		const runner = f.session.extensionRunner;
		if (!runner) throw new Error("Fixture must bind a real extension runner");
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		expect(closed).toBe(1);
		expect(() => f.api.on("input", () => ({ action: "continue" }))).toThrow(/idle lease/);
		lease.release();
	});

	it.each(["before", "during"])(
		"counts asynchronous shutdown responsibility started %s a lease",
		async (order) => {
			const entered = barrier();
			const finish = barrier();
			const f = await fixture((pi) => {
				pi.on("session_shutdown", async () => {
					entered.resolve();
					await finish.promise;
				});
			});
			const runner = f.session.extensionRunner;
			if (!runner) throw new Error("Fixture must bind a real extension runner");
			const lease = order === "during" ? acquire(f.session) : undefined;
			const cleanup = runner.emit({ type: "session_shutdown", reason: "quit" });
			await entered.promise;
			lease?.release();
			expect(f.session.tryAcquireIdleLease()).toBeUndefined();
			finish.resolve();
			await cleanup;
			acquire(f.session).release();
		},
	);

	it.each(["sync", "throwing-promise"] as const)(
		"expires %s shutdown cleanup before detached microtasks run",
		async (mode) => {
			const queued = barrier();
			let late: Promise<unknown> | undefined;
			const f = await fixture((pi) => {
				pi.on("session_shutdown", () => {
					queueMicrotask(() => {
						late = pi.exec(process.execPath, ["-e", ""]).then(
							(result) => result,
							(error) => error,
						);
						queued.resolve();
					});
					if (mode === "throwing-promise") {
						const result = Promise.resolve();
						Object.defineProperty(result, "constructor", {
							get() {
								throw new Error("invalid promise constructor");
							},
						});
						return result;
					}
				});
			});
			const lease = acquire(f.session);
			try {
				await emitSessionShutdown(f.session);
				await queued.promise;
				expect(await late).toBeInstanceOf(Error);
				expect(String(await late)).toMatch(/idle lease/);
			} finally {
				lease.release();
			}
		},
	);

	it("isolates shutdown exec cleanup from concurrent and expired contexts", async () => {
		const entered = barrier();
		const finish = barrier();
		const late = barrier();
		const lateDone = barrier();
		let lateError: unknown;
		let cleanupExit: number | null | undefined;
		const f = await fixture((pi) => {
			pi.on("session_shutdown", async () => {
				void late.promise.then(async () => {
					try {
						await pi.exec(process.execPath, ["-e", "process.exit(0)"]);
					} catch (error) {
						lateError = error;
					} finally {
						lateDone.resolve();
					}
				});
				entered.resolve();
				await finish.promise;
				expect(() => pi.appendEntry("blocked", {})).toThrow(/idle lease/);
				expect(() => pi.on("input", () => ({ action: "continue" }))).toThrow(/idle lease/);
				const result = await pi.exec(process.execPath, [
					"--eval",
					"require('node:fs').writeFileSync(process.argv[1], 'clean')",
					join(f.cwd, "clean"),
				]);
				cleanupExit = result.code;
			});
		});
		const lease = acquire(f.session);
		const shutdown = emitSessionShutdown(f.session);
		try {
			await entered.promise;
			await expect(f.api.exec(process.execPath, ["-e", "process.exit(0)"])).rejects.toThrow(/idle lease/);
			await expect(f.session.prompt("blocked")).rejects.toThrow(/idle lease/);
			finish.resolve();
			await shutdown;
			expect(f.errors).toEqual([]);
			expect(cleanupExit).toBe(0);
			expect(existsSync(join(f.cwd, "clean"))).toBe(true);
			late.resolve();
			await lateDone.promise;
			expect(lateError).toBeInstanceOf(Error);
			expect(String(lateError)).toMatch(/idle lease/);
		} finally {
			finish.resolve();
			late.resolve();
			await shutdown;
			lease.release();
		}
	});

	it("rejects SDK extension exec before spawning while held", async () => {
		const f = await fixture();
		const output = join(f.cwd, "must-not-exist");
		const lease = acquire(f.session);
		try {
			await expect(
				f.api.exec(process.execPath, [
					"-e",
					"require('node:fs').writeFileSync(process.argv[1], 'bad')",
					output,
				]),
			).rejects.toThrow(/idle lease/);
			expect(existsSync(output)).toBe(false);
		} finally {
			lease.release();
		}
	});
});
