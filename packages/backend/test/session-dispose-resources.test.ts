import { EventEmitter } from "node:events";
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
afterEach(() => {
	for (const backend of backends.splice(0)) backend.dispose();
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
			messages: [],
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
		const stop = vi.spyOn(internal.traces, "stop").mockImplementation(() => {
			order.push("trace");
			return new Promise<void>((resolve) => {
				endTrace = resolve;
			});
		});
		let done = false;
		const close = backend.closeSession("normal").then((value) => {
			done = true;
			return value;
		});
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
			fixture.watcher.mockImplementation(() => {
				throw Error("watcher fault");
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
			vi.mocked(fixture.entry.session.dispose).mockImplementation(() => {
				throw Error("SDK fault");
			});
			if (path === "normal")
				await expect(fixture.backend.closeSession(`fault-${path}`)).resolves.toEqual({ closed: true });
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
				await expect(fixture.backend.closeSession(`aux-${path}`)).resolves.toEqual({ closed: true });
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
		registry.delete("entry");
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
