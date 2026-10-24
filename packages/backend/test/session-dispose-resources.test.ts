import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSubscriptionRegistry } from "../src/channel-subscriptions";
import { PermissionGate } from "../src/permissions/gate";
import { PiBackend } from "../src/pi-backend";
import { ExtensionDialogHost } from "../src/session/extension-dialog-host";
import type { SessionHydrationGate } from "../src/session/hydration-gate";
import type { EventRateTracker } from "../src/session/rates";
import { type RegisteredSession, releaseEntryResources, SessionRegistry } from "../src/session/registry";
import type { StreamGuard } from "../src/session/stream-guard";
import type { GuardTriggerMarkers } from "../src/tools/compaction-guard/trigger-marker";

const channelFactory = vi.hoisted(() => ({
	options: undefined as
		| undefined
		| {
				onSubscriptionsChanged: (id: string, topics: ReadonlySet<string>) => void;
				isSessionAlive: (id: string) => boolean;
		  },
}));
// Intercept watcher construction only; the captured producer callbacks and all lifecycle state are real.
vi.mock("../src/tools/channel-watch", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/tools/channel-watch")>()),
	makeChannelWatchExtension: (options: NonNullable<typeof channelFactory.options>) => {
		channelFactory.options = options;
		return () => {};
	},
}));

interface Internals {
	buildExtensionFactories(cwd: string, confirm: undefined, modeRef: RegisteredSession["modeRef"]): unknown[];
	registry: SessionRegistry;
	historyGate: SessionHydrationGate;
	channelSubs: ChannelSubscriptionRegistry;
	streamGuard: StreamGuard;
	guardTriggerMarkers: GuardTriggerMarkers;
	eventRates: EventRateTracker;
	channelWatchCleanups: WeakMap<RegisteredSession["modeRef"], () => void>;
	traces: { stop(id: string): Promise<void>; disposeAll(): void };
}
const backends: PiBackend[] = [];
const pendingResourceCleanup: Array<() => void> = [];
afterEach(() => {
	for (const backend of backends.splice(0)) backend.dispose();
	// Assertions may fail before a deferred release; settle retained resource timers independently.
	for (const cleanup of pendingResourceCleanup.splice(0)) cleanup();
	vi.restoreAllMocks();
});
function setup(id: string, shutdown: () => Promise<void> = async () => {}) {
	const backend = new PiBackend({
		projectTrust: false,
		permissionGates: false,
		subagentPreferBuiltin: false,
	});
	backends.push(backend);
	const internal = backend as unknown as Internals;
	const order: string[] = [],
		resolved: unknown[] = [];
	const sdkEvents = new EventEmitter();
	const sdkListener = () => {};
	sdkEvents.on("event", sdkListener);
	const gate = new PermissionGate(() => {});
	gate.bindSession(id);
	const dialogs = new ExtensionDialogHost({
		onRequest: () => {},
		onResolved: (value) => resolved.push(value),
	});
	dialogs.bind(id);
	const entry = {
		session: {
			sessionId: id,
			isStreaming: false,
			clearQueue: vi.fn(),
			abort: vi.fn(async () => {
				order.push("abort");
			}),
			messages: [],
			sessionManager: { getSessionDir: () => undefined, getSessionFile: () => undefined },
			extensionRunner: {
				emit: () => {
					order.push("shutdown");
					return shutdown();
				},
			},
			dispose: vi.fn(() => {
				order.push("sdk");
			}),
		},
		unsubscribe: vi.fn(() => {
			order.push("unsubscribe");
			sdkEvents.removeListener("event", sdkListener);
		}),
		gate,
		dialogs,
		cwd: "/isolated/fixture",
		modeRef: { current: "default" },
	} as unknown as RegisteredSession;
	internal.registry.add(entry);
	internal.buildExtensionFactories(entry.cwd, undefined, entry.modeRef);
	const producer = channelFactory.options;
	if (!producer) throw Error("watcher producer callbacks not captured");
	internal.channelSubs.noteSessionOpened(id);
	internal.channelSubs.report(id, new Set(["topic"]));
	internal.guardTriggerMarkers.mark(id);
	internal.eventRates.tick(id);
	const watcher = vi.fn(() => {
		order.push("watcher");
	});
	internal.channelWatchCleanups.set(entry.modeRef, watcher);
	// Real pending resources; cancel/dispose must settle them rather than merely call spies.
	const permission = gate.confirm("Approval", "fixture operation");
	const dialog = dialogs.ask("confirm", { title: "Dialog", message: "fixture" }, { timeout: 60000 });
	const history = internal.historyGate.wait(id);
	const native = {
		gate: gate.dispose.bind(gate),
		dialogs: dialogs.dispose.bind(dialogs),
		history: internal.historyGate.cancel.bind(internal.historyGate),
	};
	pendingResourceCleanup.push(() => {
		native.gate();
		native.dialogs();
		native.history(id);
		sdkEvents.removeAllListeners();
	});
	const gateDispose = vi.spyOn(gate, "dispose"),
		dialogDispose = vi.spyOn(dialogs, "dispose");
	const historyCancel = vi.spyOn(internal.historyGate, "cancel");
	const stream = {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: " ".repeat(200000) },
	};
	expect(internal.streamGuard.inspect(id, stream as never)).toBe("trip_whitespace");
	return {
		backend,
		internal,
		producer,
		sdkEvents,
		native,
		entry,
		order,
		resolved,
		permission,
		dialog,
		history,
		watcher,
		gateDispose,
		dialogDispose,
		historyCancel,
	};
}
function assertAuxiliaryReleased(fixture: ReturnType<typeof setup>, id: string) {
	const { internal, entry } = fixture;
	expect(internal.registry.has(id)).toBe(false);
	expect(fixture.sdkEvents.listenerCount("event")).toBe(0);
	expect(internal.channelWatchCleanups.has(entry.modeRef)).toBe(false);
	expect(internal.eventRates.snapshot().has(id)).toBe(false);
	expect(internal.channelSubs.snapshot(id)).toMatchObject({ live: false, topics: [] });
	expect(
		internal.guardTriggerMarkers.rewrite(id, { type: "compaction_start", reason: "manual" }).reason,
	).toBe("manual");
	expect(
		internal.streamGuard.inspect(id, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "ok" },
		} as never),
	).toBe("pass");
	internal.streamGuard.cleanup(id);
}

describe("registered session lifetime uses real pending resources and auxiliary state", () => {
	it("normal close waits for shutdown, keeps history cancel position and awaits trace stop; repeated close is idempotent", async () => {
		let endShutdown!: () => void;
		const fixture = setup(
			"normal",
			() =>
				new Promise<void>((resolve) => {
					endShutdown = resolve;
				}),
		);
		const { backend, internal, entry, order } = fixture;
		const oldCancel = fixture.native.history;
		fixture.historyCancel.mockImplementation((id) => {
			order.push("history");
			oldCancel(id);
		});
		const oldGate = fixture.native.gate,
			oldDialogs = fixture.native.dialogs;
		fixture.gateDispose.mockImplementation(() => {
			order.push("gate");
			oldGate();
		});
		fixture.dialogDispose.mockImplementation(() => {
			order.push("dialogs");
			oldDialogs();
		});
		let endTrace!: () => void;
		const traceCompleted = new Promise<void>((resolve) => {
			endTrace = resolve;
		});
		const stop = vi.spyOn(internal.traces, "stop").mockImplementation(() => {
			order.push("trace");
			return traceCompleted;
		});
		let done = false;
		const close = backend.closeSession("normal").then((value) => {
			done = true;
			return value;
		});
		await Promise.resolve();
		try {
			expect(order).toEqual(["watcher", "shutdown"]);
			expect(done).toBe(false);
			expect(internal.registry.has("normal")).toBe(true);
			endShutdown();
			await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
			expect(order).toEqual([
				"watcher",
				"shutdown",
				"sdk",
				"history",
				"unsubscribe",
				"gate",
				"dialogs",
				"trace",
			]);
			expect(done).toBe(false);
			assertAuxiliaryReleased(fixture, "normal");
			endTrace();
			expect(await close).toEqual({ closed: true });
			expect(await fixture.permission).toBe(false);
			expect(await fixture.dialog).toBe(false);
			expect(await fixture.history).toBe(false);
			expect(fixture.resolved).toMatchObject([{ reason: "sessionClosed" }]);
			expect(await backend.closeSession("normal")).toEqual({ closed: true });
			for (const spy of [
				fixture.watcher,
				entry.unsubscribe,
				entry.session.dispose,
				fixture.gateDispose,
				fixture.dialogDispose,
				fixture.historyCancel,
				stop,
			])
				expect(spy).toHaveBeenCalledOnce();
		} finally {
			endShutdown?.();
			endTrace?.();
			await close;
		}
	});
	it("quit returns synchronously while shutdown is pending, releases gates/history/state and ignores late reports", async () => {
		let endShutdown!: () => void;
		const fixture = setup(
			"quit",
			() =>
				new Promise<void>((resolve) => {
					endShutdown = resolve;
				}),
		);
		try {
			const generation = fixture.internal.channelSubs.snapshot("quit").generation;
			expect(fixture.backend.dispose()).toBeUndefined();
			expect(fixture.order).toEqual(["watcher", "unsubscribe", "shutdown", "sdk"]);
			assertAuxiliaryReleased(fixture, "quit");
			expect(await fixture.permission).toBe(false);
			expect(await fixture.dialog).toBe(false);
			expect(await fixture.history).toBe(false);
			fixture.producer.onSubscriptionsChanged("quit", new Set());
			expect(fixture.producer.isSessionAlive("quit")).toBe(false);
			expect(fixture.internal.channelSubs.snapshot("quit")).toMatchObject({
				generation,
				live: false,
				topics: [],
			});
			fixture.backend.dispose();
			for (const spy of [
				fixture.watcher,
				fixture.entry.unsubscribe,
				fixture.entry.session.dispose,
				fixture.gateDispose,
				fixture.dialogDispose,
				fixture.historyCancel,
			])
				expect(spy).toHaveBeenCalledOnce();
		} finally {
			endShutdown?.();
			await Promise.resolve();
		}
	});
	it.each(["normal", "quit"])(
		"%s: resource exceptions do not skip later releases or registered sessions",
		async (path) => {
			const fixture = setup(`fault-${path}`, async () => {
				throw Error("shutdown fault");
			});
			const secondGate = new PermissionGate(() => {}),
				secondDialogs = new ExtensionDialogHost({ onRequest: () => {}, onResolved: () => {} });
			const second = {
				...fixture.entry,
				session: {
					...fixture.entry.session,
					sessionId: "second",
					extensionRunner: undefined,
					dispose: vi.fn(),
				},
				gate: secondGate,
				dialogs: secondDialogs,
				modeRef: { current: "default" },
				unsubscribe: vi.fn(),
			} as unknown as RegisteredSession;
			fixture.internal.registry.add(second);
			const oldGate = fixture.native.gate,
				oldDialogs = fixture.native.dialogs;
			const firstFailure = Error("watcher fault");
			fixture.watcher.mockImplementation(() => {
				throw firstFailure;
			});
			vi.mocked(fixture.entry.unsubscribe).mockImplementation(() => {
				fixture.sdkEvents.removeAllListeners("event");
				throw Error("unsubscribe fault");
			});
			fixture.gateDispose.mockImplementation(() => {
				oldGate();
				throw Error("gate fault");
			});
			fixture.dialogDispose.mockImplementation(() => {
				oldDialogs();
				throw Error("dialogs fault");
			});
			const sdkFailure = Error("SDK fault");
			vi.mocked(fixture.entry.session.dispose).mockImplementation(() => {
				throw sdkFailure;
			});
			if (path === "normal")
				await expect(fixture.backend.closeSession(`fault-${path}`)).rejects.toBe(firstFailure);
			else expect(fixture.backend.dispose()).toBeUndefined();
			assertAuxiliaryReleased(fixture, `fault-${path}`);
			expect(await fixture.permission).toBe(false);
			expect(await fixture.dialog).toBe(false);
			expect(await fixture.history).toBe(false);
			if (path === "normal") fixture.backend.dispose();
			expect(second.unsubscribe).toHaveBeenCalledOnce();
			expect(second.session.dispose).toHaveBeenCalledOnce();
		},
	);
	it.each(["normal", "quit"])(
		"%s: auxiliary failures still reach every later group and trace owner",
		async (path) => {
			const fixture = setup(`aux-${path}`),
				{ internal } = fixture;
			const marker = internal.guardTriggerMarkers.clear.bind(internal.guardTriggerMarkers);
			const channel = internal.channelSubs.dispose.bind(internal.channelSubs);
			const stream = internal.streamGuard.cleanup.bind(internal.streamGuard);
			const rate = internal.eventRates.delete.bind(internal.eventRates);
			const markerSpy = vi.spyOn(internal.guardTriggerMarkers, "clear").mockImplementation((id) => {
				marker(id);
				throw Error("marker fault");
			});
			fixture.historyCancel.mockImplementation((id) => {
				fixture.native.history(id);
				throw Error("history fault");
			});
			const channelSpy = vi.spyOn(internal.channelSubs, "dispose").mockImplementation((id) => {
				channel(id);
				throw Error("channel fault");
			});
			const streamSpy = vi.spyOn(internal.streamGuard, "cleanup").mockImplementation((id) => {
				stream(id);
				throw Error("stream fault");
			});
			const rateSpy = vi.spyOn(internal.eventRates, "delete").mockImplementation((id) => {
				rate(id);
				throw Error("rate fault");
			});
			const trace =
				path === "normal"
					? vi.spyOn(internal.traces, "stop").mockRejectedValue(Error("trace fault"))
					: vi.spyOn(internal.traces, "disposeAll");
			if (path === "normal")
				await expect(fixture.backend.closeSession(`aux-${path}`)).rejects.toThrow("marker fault");
			else expect(fixture.backend.dispose()).toBeUndefined();
			for (const spy of [
				markerSpy,
				fixture.historyCancel,
				channelSpy,
				streamSpy,
				rateSpy,
				trace,
				fixture.watcher,
			])
				expect(spy).toHaveBeenCalledOnce();
			expect(internal.registry.has(`aux-${path}`)).toBe(false);
			expect(await fixture.permission).toBe(false);
			expect(await fixture.dialog).toBe(false);
			expect(await fixture.history).toBe(false);
			expect(internal.channelSubs.snapshot(`aux-${path}`)).toMatchObject({ live: false, topics: [] });
			expect(internal.eventRates.snapshot().has(`aux-${path}`)).toBe(false);
		},
	);
	it("close/reopen produces a new incarnation without reviving the disposed generation", async () => {
		const fixture = setup("reopen");
		const before = fixture.internal.channelSubs.snapshot("reopen");
		await fixture.backend.closeSession("reopen");
		fixture.producer.onSubscriptionsChanged("reopen", new Set());
		expect(fixture.internal.channelSubs.snapshot("reopen")).toMatchObject({
			generation: before.generation,
			live: false,
			topics: [],
		});
		const next = {
			...fixture.entry,
			session: { ...fixture.entry.session, dispose: vi.fn(), extensionRunner: undefined },
			unsubscribe: vi.fn(),
			gate: new PermissionGate(() => {}),
			dialogs: new ExtensionDialogHost({ onRequest: () => {}, onResolved: () => {} }),
			modeRef: { current: "default" },
		} as unknown as RegisteredSession;
		fixture.internal.registry.add(next);
		fixture.internal.channelSubs.noteSessionOpened("reopen");
		fixture.internal.channelSubs.report("reopen", new Set(["new"]));
		const current = fixture.internal.channelSubs.snapshot("reopen");
		fixture.producer.onSubscriptionsChanged("reopen", new Set(["late-old"]));
		expect(fixture.producer.isSessionAlive("reopen")).toBe(false);
		expect(fixture.internal.channelSubs.snapshot("reopen")).toEqual(current);
		expect(current.generation).toBeGreaterThan(before.generation);
		expect(current).toMatchObject({ live: true, topics: ["new"] });
	});
});

describe("normal disposal errors and overlapping entry ownership", () => {
	it.each(["SDK", "entry", "trace"])(
		"%s failure preserves first error identity, cleans tail and prevents delete unlink",
		async (stage) => {
			const directory = mkdtempSync(join(tmpdir(), "dispose-error-")),
				file = join(directory, "session.jsonl");
			const failure = Error(`${stage} first`),
				later = Error("later trace error");
			const fixture = setup(`error-${stage}`);
			writeFileSync(file, "fixture");
			const stop = vi.spyOn(fixture.internal.traces, "stop");
			if (stage === "SDK")
				vi.mocked(fixture.entry.session.dispose).mockImplementation(() => {
					throw failure;
				});
			if (stage === "entry")
				vi.mocked(fixture.entry.unsubscribe).mockImplementation(() => {
					fixture.sdkEvents.removeAllListeners();
					throw failure;
				});
			stop.mockRejectedValue(stage === "trace" ? failure : later);
			try {
				const close = fixture.backend.closeSession(`error-${stage}`),
					deletion = fixture.backend.deleteSession(`error-${stage}`, file);
				await Promise.all([expect(close).rejects.toBe(failure), expect(deletion).rejects.toBe(failure)]);
				expect(existsSync(file)).toBe(true);
				assertAuxiliaryReleased(fixture, `error-${stage}`);
				expect(await fixture.permission).toBe(false);
				expect(await fixture.dialog).toBe(false);
				expect(await fixture.history).toBe(false);
				for (const spy of [
					fixture.entry.session.dispose,
					fixture.entry.unsubscribe,
					fixture.gateDispose,
					fixture.dialogDispose,
					stop,
				])
					expect(spy).toHaveBeenCalledOnce();
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
	it.each(["close", "delete"])(
		"overlapping close/%s waits for shared shutdown and trace completion, exactly once",
		async (secondAction) => {
			let releaseShutdown: () => void = () => {},
				releaseTrace: () => void = () => {};
			const fixture = setup(
				`overlap-${secondAction}`,
				() =>
					new Promise<void>((resolve) => {
						releaseShutdown = resolve;
					}),
			);
			const directory = mkdtempSync(join(tmpdir(), "dispose-overlap-")),
				file = join(directory, "session.jsonl");
			writeFileSync(file, "fixture");
			const channel = vi.spyOn(fixture.internal.channelSubs, "dispose");
			const traceCompleted = new Promise<void>((resolve) => {
				releaseTrace = resolve;
			});
			const stop = vi.spyOn(fixture.internal.traces, "stop").mockReturnValue(traceCompleted);
			let firstDone = false,
				secondDone = false;
			const first = fixture.backend.closeSession(`overlap-${secondAction}`).then(() => {
				firstDone = true;
			});
			const second = (
				secondAction === "close"
					? fixture.backend.closeSession(`overlap-${secondAction}`)
					: fixture.backend.deleteSession(`overlap-${secondAction}`, file)
			).then(() => {
				secondDone = true;
			});
			try {
				await Promise.resolve();
				expect(fixture.order.filter((item) => item === "shutdown")).toHaveLength(1);
				expect(firstDone).toBe(false);
				expect(secondDone).toBe(false);
				expect(existsSync(file)).toBe(true);
				expect(fixture.internal.registry.get(`overlap-${secondAction}`)).toBe(fixture.entry);
				releaseShutdown();
				await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
				expect(firstDone).toBe(false);
				expect(secondDone).toBe(false);
				expect(existsSync(file)).toBe(true);
				releaseTrace();
				await Promise.all([first, second]);
				expect(existsSync(file)).toBe(secondAction === "close");
				for (const spy of [
					fixture.watcher,
					fixture.entry.unsubscribe,
					fixture.entry.session.dispose,
					fixture.gateDispose,
					fixture.dialogDispose,
					fixture.historyCancel,
					channel,
					stop,
				])
					expect(spy).toHaveBeenCalledOnce();
			} finally {
				releaseShutdown();
				releaseTrace();
				await Promise.allSettled([first, second]);
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
	it.each([false, true])(
		"pending normal + synchronous quit: old continuation skips cleanup, reopened=%s",
		async (reopen) => {
			let releaseShutdown: () => void = () => {};
			const fixture = setup(
				"quit-race",
				() =>
					new Promise<void>((resolve) => {
						releaseShutdown = resolve;
					}),
			);
			// Quit may emit another best-effort shutdown, but only the original normal emission stays pending.
			const emit = vi
				.spyOn(fixture.entry.session.extensionRunner, "emit")
				.mockImplementationOnce(
					() =>
						new Promise<void>((resolve) => {
							releaseShutdown = resolve;
						}),
				)
				.mockResolvedValue(undefined);
			const channel = vi.spyOn(fixture.internal.channelSubs, "dispose"),
				stop = vi.spyOn(fixture.internal.traces, "stop");
			const close = fixture.backend.closeSession("quit-race");
			let next: RegisteredSession | undefined, nextHistory: Promise<boolean> | undefined;
			try {
				await Promise.resolve();
				expect(emit).toHaveBeenCalledOnce();
				expect(fixture.backend.dispose()).toBeUndefined();
				expect(fixture.entry.session.dispose).toHaveBeenCalledOnce();
				expect(channel).toHaveBeenCalledOnce();
				const closed = fixture.internal.channelSubs.snapshot("quit-race");
				if (reopen) {
					next = {
						...fixture.entry,
						session: {
							...fixture.entry.session,
							dispose: vi.fn(),
							extensionRunner: { emit: vi.fn().mockResolvedValue(undefined) },
						},
						unsubscribe: vi.fn(),
						gate: new PermissionGate(() => {}),
						dialogs: new ExtensionDialogHost({ onRequest: () => {}, onResolved: () => {} }),
						modeRef: { current: "default" },
					} as unknown as RegisteredSession;
					fixture.internal.registry.add(next);
					fixture.internal.channelSubs.noteSessionOpened("quit-race");
					fixture.internal.channelSubs.report("quit-race", new Set(["new"]));
					nextHistory = fixture.internal.historyGate.wait("quit-race");
				}
				const current = fixture.internal.channelSubs.snapshot("quit-race");
				if (reopen) expect(current.generation).toBeGreaterThan(closed.generation);
				releaseShutdown();
				await expect(close).resolves.toEqual({ closed: true });
				expect(fixture.internal.channelSubs.snapshot("quit-race")).toEqual(current);
				for (const spy of [
					fixture.entry.session.dispose,
					fixture.entry.unsubscribe,
					fixture.gateDispose,
					fixture.dialogDispose,
					fixture.historyCancel,
					channel,
				])
					expect(spy).toHaveBeenCalledOnce();
				expect(stop).not.toHaveBeenCalled();
				if (next) {
					expect(fixture.internal.registry.get("quit-race")).toBe(next);
					expect(next.session.dispose).not.toHaveBeenCalled();
					fixture.internal.historyGate.ack("quit-race");
					expect(await nextHistory).toBe(true);
				}
			} finally {
				releaseShutdown();
				await Promise.allSettled([close]);
				fixture.internal.historyGate.cancel("quit-race");
				await nextHistory;
			}
		},
	);
});

describe("registry owns entry release, not SDK lifetime on delete", () => {
	it("delete twice/disposeAll does not double release; failures cannot skip gate/dialogs", () => {
		const registry = new SessionRegistry();
		const unsubscribe = vi.fn(() => {
				throw Error("unsubscribe");
			}),
			gate = {
				dispose: vi.fn(() => {
					throw Error("gate");
				}),
			},
			dialogs = { dispose: vi.fn() },
			dispose = vi.fn();
		registry.add({
			session: { sessionId: "entry", dispose },
			unsubscribe,
			gate,
			dialogs,
		} as unknown as RegisteredSession);
		expect(() => registry.delete("entry")).toThrow("unsubscribe");
		registry.delete("entry");
		registry.disposeAll();
		for (const spy of [unsubscribe, gate.dispose, dialogs.dispose]) expect(spy).toHaveBeenCalledOnce();
		expect(dispose).not.toHaveBeenCalled();
	});
	it("disposeAll hook errors do not skip instance release, SDK disposal, afterhook or next entry", () => {
		const registry = new SessionRegistry(),
			order: string[] = [];
		for (const id of ["one", "two"])
			registry.add({
				session: {
					sessionId: id,
					dispose: () => {
						order.push(`${id}:sdk`);
					},
				},
				unsubscribe: () => {
					order.push(`${id}:unsubscribe`);
				},
				gate: { dispose: () => {} },
				dialogs: { dispose: () => {} },
			} as unknown as RegisteredSession);
		expect(
			registry.disposeAll({
				beforeShutdown: (entry) => {
					order.push(`${entry.session.sessionId}:before`);
					throw Error("before");
				},
				afterDispose: (entry) => {
					expect(registry.has(entry.session.sessionId)).toBe(false);
					order.push(`${entry.session.sessionId}:after`);
					throw Error("after");
				},
			}),
		).toBeUndefined();
		expect(order).toEqual([
			"one:before",
			"one:unsubscribe",
			"one:sdk",
			"one:after",
			"two:before",
			"two:unsubscribe",
			"two:sdk",
			"two:after",
		]);
		expect(registry.list()).toEqual([]);
	});
	it("instance release does not perform an id lookup or dispose an SDK holder", () => {
		const gate = { dispose: vi.fn() },
			dialogs = { dispose: vi.fn() },
			unsubscribe = vi.fn();
		expect(
			releaseEntryResources({ gate, dialogs, unsubscribe } as unknown as RegisteredSession),
		).toBeUndefined();
		for (const spy of [unsubscribe, gate.dispose, dialogs.dispose]) expect(spy).toHaveBeenCalledOnce();
	});
});

describe("irreversible remote shutdown", () => {
	it("cancels pending work, fences channel wakeups and awaits shutdown before invalidating SDK context", async () => {
		let finish!: () => void;
		const waiting = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const fixture = setup("remote-stop", () => waiting);
		const stopped = fixture.backend.shutdown();
		expect(fixture.producer.isSessionAlive("remote-stop")).toBe(false);
		await expect(fixture.permission).resolves.toBe(false);
		await expect(fixture.dialog).resolves.toBe(false);
		await expect(fixture.backend.prompt("remote-stop", "new work")).rejects.toThrow("STOPPING");
		expect(fixture.entry.session.dispose).not.toHaveBeenCalled();
		finish();
		await stopped;
		expect(fixture.order.indexOf("abort")).toBeLessThan(fixture.order.indexOf("shutdown"));
		expect(fixture.order.indexOf("shutdown")).toBeLessThan(fixture.order.indexOf("sdk"));
		expect(fixture.backend.shutdown()).toBe(stopped);
	});
	it("reports SDK shutdown failure after releasing managed resources instead of claiming success", async () => {
		const fixture = setup("remote-failed-stop", async () => {
			throw new Error("MCP close failed");
		});
		await expect(fixture.backend.shutdown()).rejects.toThrow("did not complete cleanly");
		expect(fixture.entry.session.dispose).toHaveBeenCalledOnce();
		expect(fixture.internal.registry.has("remote-failed-stop")).toBe(false);
	});
	it("a creation suspended before resource construction cannot resume after the stop fence", async () => {
		const backend = new PiBackend({
			projectTrust: false,
			permissionGates: false,
			subagentPreferBuiltin: false,
		});
		backends.push(backend);
		let enter!: () => void, release!: (runtime: unknown) => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const runtime = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		const internal = backend as unknown as { getModelRuntime(): Promise<unknown>; registry: SessionRegistry };
		vi.spyOn(internal, "getModelRuntime").mockImplementation(() => {
			enter();
			return runtime;
		});
		const creating = backend.createSession({ cwd: "/isolated/remote-project" });
		await entered;
		const rejected = expect(creating).rejects.toThrow("STOPPING");
		const stopped = backend.shutdown();
		release({});
		await rejected;
		await stopped;
		expect(internal.registry.list()).toEqual([]);
	});
});

it("stopping also cancels a dialog opened while a session is still being constructed", async () => {
	const backend = new PiBackend({
		projectTrust: false,
		permissionGates: false,
		subagentPreferBuiltin: false,
	});
	backends.push(backend);
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const internal = backend as unknown as {
		subagentPreferBuiltin(): Promise<boolean>;
		wireSession(cwd: string, readOnly: undefined, make: () => Promise<unknown>): Promise<unknown>;
	};
	vi.spyOn(internal, "subagentPreferBuiltin").mockResolvedValue(false);
	const shutdown = vi.fn(async () => {}),
		dispose = vi.fn();
	const session = {
		sessionId: "constructing",
		bindExtensions: async ({ uiContext }: { uiContext: { input: (title: string) => Promise<unknown> } }) => {
			entered();
			await uiContext.input("Startup input");
		},
		extensionRunner: { emit: shutdown },
		dispose,
	};
	const creating = internal.wireSession("/isolated/constructing", undefined, async () => ({
		session,
		extensionsResult: { extensions: [], errors: [] },
	}));
	const rejected = expect(creating).rejects.toThrow("STOPPING");
	await waiting;
	backend.beginShutdown();
	await rejected;
	await backend.shutdown();
	expect(shutdown).toHaveBeenCalledOnce();
	expect(dispose).toHaveBeenCalledOnce();
});

it("recovers and answers session_start dialogs before the session enters the registry", async () => {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	backends.push(backend);
	const internal = backend as unknown as {
		bindSessionExtensions(session: unknown, id: string, cwd: string): Promise<ExtensionDialogHost>;
	};
	let entered!: () => void, answer: unknown;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const binding = internal.bindSessionExtensions(
		{
			bindExtensions: async ({ uiContext }: { uiContext: { input(title: string): Promise<unknown> } }) => {
				const result = uiContext.input("Startup recovery");
				entered();
				answer = await result;
			},
		},
		"not-registered",
		"/isolated/initializing",
	);
	await waiting;
	expect(backend.getLoadedSessions()).toEqual([]);
	const snapshot = backend.getPendingInteractions();
	expect(snapshot.dialogs).toHaveLength(1);
	expect(snapshot.dialogs[0]).toMatchObject({
		sessionId: "not-registered",
		cwd: "/isolated/initializing",
		title: "Startup recovery",
	});
	const id = snapshot.dialogs[0].id;
	backend.respondExtensionDialog(id, { value: "exactly once" });
	backend.respondExtensionDialog(id, { value: "stale" });
	const host = await binding;
	expect(answer).toBe("exactly once");
	expect(backend.getPendingInteractions().dialogs).toEqual([]);
	host.dispose();
});
