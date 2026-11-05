// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	active: "A",
	transcripts: {} as Record<string, any>,
	load: vi.fn(),
	older: vi.fn(),
	windowed: false,
	longWindow: false,
	rail: false,
}));

vi.mock("@percho/shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@percho/shared")>();
	return {
		...actual,
		buildChatRows: ({ messages }: any) =>
			messages.map((message: any) => ({ kind: "message", key: message.id, message })),
		deriveTurnChanges: () => [],
		deriveTurnTimings: () => [],
		isAgentWorking: () => false,
	};
});
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: Object.assign((select: any) => select({ activeSessionId: fixture.active }), {
		getState: () => ({ activeSessionId: fixture.active, sessions: [] }),
	}),
}));
vi.mock("../../stores/transcript", () => ({
	selectTranscript: (state: any, id: string) => state.bySession[id],
	useTranscriptStore: Object.assign((select: any) => select({ bySession: fixture.transcripts }), {
		getState: () => ({ bySession: fixture.transcripts }),
	}),
}));
vi.mock("../../stores/session-history", () => ({ historyOpenEpoch: () => 1, reloadSessionHistory: vi.fn() }));
vi.mock("../../stores/session-history-paging", () => ({
	loadHistoryThrough: fixture.load,
	loadOlderHistory: fixture.older,
	loadSessionNavigation: vi.fn(async () => null),
}));
vi.mock("../../stores/ui-preferences", () => ({
	useUiPreferencesStore: (select: any) =>
		select({ centerOrbEnabled: false, codeFontSize: 14, uiFontSize: 14, sessionRailEnabled: false }),
}));
vi.mock("../../stores/session-workspace", () => ({
	useSessionWorkspaceStore: (select: any) => select({ members: [] }),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../lib/use-edge-fade", () => ({ useEdgeFade: () => {} }));
vi.mock("./use-shown-working", () => ({ useShownWorking: () => false }));
vi.mock("./history-image/history-image-service", () => ({
	thumbnailService: () => ({ cancelView: () => {} }),
}));
vi.mock("./history-image/history-image-root", () => ({
	HistoryImageRootProvider: ({ children }: any) => children,
}));
vi.mock("../ui/DeferredDetails", async () => {
	const React = await import("react");
	return { SessionViewContext: React.createContext(null) };
});
vi.mock("./MessageItem", () => ({
	MessageItem: ({ message }: any) => <div data-target={message.id}>{message.id}</div>,
}));
vi.mock("./MessageRail", () => ({
	MessageRail: ({ onJump }: any) => (
		<>
			<button type="button" onClick={() => onJump({ index: -1, entryId: "old" })}>
				old
			</button>
			<button type="button" onClick={() => onJump({ index: 0 })}>
				loaded
			</button>
		</>
	),
}));
vi.mock("./message-rail", () => ({
	railNodes: () => (fixture.rail ? [{ index: 0 }, { index: 1 }] : []),
	turnsInView: () => (fixture.rail ? { from: 1, to: 1 } : null),
}));
vi.mock("./virtual-window", () => ({
	windowFor: (positions: any, top: number) => ({
		start: fixture.rail ? 2 : fixture.longWindow ? 0 : fixture.windowed && top >= 0 ? 1 : 0,
		end: fixture.longWindow ? Math.min(2, positions.count) : (positions.count ?? 2),
	}),
}));
vi.mock("./SelectionToolbar", () => ({ SelectionToolbar: () => null }));
vi.mock("./CenterOrb", () => ({ CenterOrb: () => null }));
vi.mock("./CompactionPauseNote", () => ({ CompactionPauseNote: () => null }));
vi.mock("./RetryNote", () => ({ RetryNote: () => null }));
vi.mock("./MetaGroup", () => ({ MetaGroup: () => null }));
vi.mock("./SubagentRunCard", () => ({ SubagentRunCard: () => null }));
vi.mock("./TurnDiffChip", () => ({ TurnDiffChip: () => null }));
vi.mock("../../plugins/Slot", () => ({ Slot: () => null }));

import { MessageList } from "./MessageList";
import { RowPositions } from "./row-positions";

const message = (id: string, entryId = id) => ({ id, entryId, kind: "user" });
const transcript = () => ({
	messages: [message("present")],
	history: { generation: 1, hasOlder: true },
	baselineRevision: 1,
	agentActive: false,
});
let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let writes: number[];
let scrollTop: number;
let height: number;
let rowShift: number;
let observers: TestResizeObserver[];

class TestResizeObserver {
	constructor(private callback: ResizeObserverCallback) {
		observers.push(this);
	}
	observe() {}
	unobserve() {}
	disconnect() {}
	trigger() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

async function render() {
	await act(async () => root.render(<MessageList />));
}
async function flushFrame() {
	const pending = [...frames.values()];
	frames.clear();
	await act(async () => {
		for (const callback of pending) callback(0);
	});
}
async function drainFrames() {
	for (let n = 0; frames.size && n < 20; n++) await flushFrame();
	expect(frames.size).toBe(0);
}
function scroller() {
	const result = host.querySelector(".chat-scrollbar");
	if (!result) throw new Error("Missing scroller");
	return result;
}
function button(text: string) {
	const result = [...host.querySelectorAll("button")].find((element) => element.textContent === text);
	if (!result) throw new Error(`Missing button ${text}`);
	return result;
}
async function click(text: string) {
	await act(async () => button(text).click());
}
function deferred() {
	let resolve!: (value: boolean) => void;
	const promise = new Promise<boolean>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function complete(job: ReturnType<typeof deferred>) {
	await act(async () => {
		job.resolve(true);
		await job.promise;
	});
}
function prepend() {
	fixture.transcripts.A = {
		...fixture.transcripts.A,
		messages: [message("old-row", "old"), ...fixture.transcripts.A.messages],
	};
}

beforeEach(async () => {
	fixture.active = "A";
	fixture.transcripts = { A: transcript(), B: transcript() };
	fixture.load.mockReset();
	fixture.older.mockReset();
	fixture.windowed = false;
	fixture.longWindow = false;
	fixture.rail = false;
	observers = [];
	height = 1000;
	rowShift = 0;
	frames = new Map();
	frameId = 0;
	writes = [];
	scrollTop = 0;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++frameId;
		frames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal("ResizeObserver", TestResizeObserver);
	vi.stubGlobal("CSS", { escape: (value: string) => value });
	vi.stubGlobal("matchMedia", () => ({ matches: true }));
	vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(() => scrollTop);
	vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation((value) => {
		scrollTop = value;
		writes.push(value);
	});
	vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options: any) {
		this.scrollTop = options.top;
	});
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const top = this.hasAttribute("data-target") ? 300 + rowShift - scrollTop : 0;
		return { top, bottom: top + 40, height: 40, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} };
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await render();
	(host.querySelector("[data-chat-column]") as HTMLElement).style.paddingTop = "0px";
	await drainFrames();
	writes = [];
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("MessageList scroll regressions", () => {
	it.each([
		{ deltaY: 1, deltaX: 0 },
		{ deltaY: 0, deltaX: 20 },
	])("keeps following at the bottom after wheel $deltaY/$deltaX", async ({ deltaY, deltaX }) => {
		scrollTop = height - 200;
		await act(async () =>
			scroller().dispatchEvent(new WheelEvent("wheel", { deltaY, deltaX, bubbles: true })),
		);
		height = 1400;
		writes = [];
		await act(async () => {
			for (const observer of observers) observer.trigger();
		});
		await drainFrames();
		expect(writes).toContain(1400);
	});

	it("keeps the visible anchor mounted and restores it after a long ordinary prepend", async () => {
		fixture.longWindow = true;
		fixture.transcripts.A = {
			...fixture.transcripts.A,
			messages: [message("temporary"), message("present")],
		};
		scrollTop = 0;
		await render();
		await act(async () => scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })));
		expect(fixture.older).toHaveBeenCalledWith("A", expect.any(Function));
		const beforePrepend = fixture.older.mock.calls[0]?.[1];
		if (!beforePrepend) throw new Error("Missing prepend anchor callback");
		// An intervening update consumes the initial wheel anchor while the page is loading.
		fixture.transcripts.A = { ...fixture.transcripts.A, messages: [message("present")] };
		await render();
		const original = host.querySelector('[data-target="present"]');
		if (!original) throw new Error("Missing original anchor");
		const before = original.getBoundingClientRect().top;
		await act(async () => {
			beforePrepend();
			rowShift = 5000;
			fixture.transcripts.A = {
				...fixture.transcripts.A,
				messages: [...Array.from({ length: 100 }, (_, i) => message(`older-${i}`)), message("present")],
			};
			root.render(<MessageList />);
		});
		const anchor = host.querySelector('[data-target="present"]');
		expect(anchor).not.toBeNull();
		expect(anchor?.getBoundingClientRect().top).toBe(before);
		expect(scrollTop).toBe(5000);
	});

	it("Alt+Up jumps to the current turn when its question is outside the window", async () => {
		fixture.rail = true;
		fixture.transcripts.A = {
			...fixture.transcripts.A,
			messages: [message("previous"), message("current"), { ...message("reply"), kind: "assistant" }],
		};
		scrollTop = 1000;
		await render();
		await drainFrames();
		expect(host.querySelector('[data-target="current"]')).toBeNull();
		const positions = new RowPositions(24);
		positions.sync(["previous", "current", "reply"].map((key) => ({ key, kind: "user" })));
		writes = [];
		await act(async () =>
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }),
			),
		);
		await drainFrames();
		expect(writes).toContain(positions.offsetOf(1) - 12);
	});
});

describe("MessageList jump races", () => {
	it.each([false, true])("ignores a slow A jump after switching %s", async (back) => {
		const job = deferred();
		fixture.load.mockReturnValueOnce(job.promise);
		await click("old");
		expect(fixture.load).toHaveBeenCalledWith("A", "old", undefined, expect.any(Function));
		fixture.active = "B";
		await render();
		if (back) {
			fixture.active = "A";
			await render();
		}
		prepend();
		await render();
		await drainFrames();
		writes = [];
		await complete(job);
		await drainFrames();
		expect(writes).toEqual([]);
	});
	it.each(["bottom", "wheel", "new click"])("cancels a loading jump on %s", async (action) => {
		const job = deferred();
		fixture.load.mockReturnValueOnce(job.promise);
		await click("old");
		if (action === "bottom") await click("message.scrollToBottom");
		if (action === "wheel")
			await act(async () => scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true })));
		if (action === "new click") await click("loaded");
		await drainFrames();
		prepend();
		await render();
		await drainFrames();
		writes = [];
		await complete(job);
		await drainFrames();
		expect(writes).toEqual([]);
	});
	it("cancels the next alignment frame after switching sessions mid-alignment", async () => {
		await click("loaded");
		await flushFrame();
		expect(writes).toContain(288);
		expect(frames.size).toBeGreaterThan(0);
		fixture.active = "B";
		await render();
		writes = [];
		await drainFrames();
		expect(writes).toEqual([]);
	});
	it("keeps the jump through same-generation prepend and programmatic scroll", async () => {
		const job = deferred();
		fixture.load.mockReturnValueOnce(job.promise);
		await click("old");
		await act(async () => scroller().dispatchEvent(new Event("scroll", { bubbles: true })));
		prepend();
		await render();
		await complete(job);
		writes = [];
		await drainFrames();
		expect(writes).toContain(288);
	});
	it("coarsely positions and then precisely aligns an already loaded target outside the window", async () => {
		fixture.windowed = true;
		await render();
		(host.querySelector("[data-chat-column]") as HTMLElement).style.paddingTop = "0px";
		expect(host.querySelector('[data-target="present"]')).toBeNull();
		await click("loaded");
		writes = [];
		await drainFrames();
		expect(writes).toContain(-12);
		expect(writes).toContain(288);
	});
});
