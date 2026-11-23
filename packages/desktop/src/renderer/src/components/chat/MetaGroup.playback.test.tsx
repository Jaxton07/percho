// @vitest-environment happy-dom

import {
	type ActivityEntry,
	type AgentSessionEvent,
	buildChatRows,
	emptyTranscript,
	type MetaItem,
	reduceEvent,
	type UIToolCall,
} from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MetaGroup } from "./MetaGroup";

vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <span /> }));
const locale = vi.hoisted(() => ({ language: "en" }));
vi.mock("../../i18n", async () => {
	const { en } = await import("../../i18n/en");
	const { zh } = await import("../../i18n/zh");
	return {
		useI18nStore: (select: (s: typeof locale) => unknown) => select(locale),
		useT: () => (key: string) =>
			key
				.split(".")
				.reduce<unknown>(
					(value, part) => (value as Record<string, unknown>)?.[part],
					locale.language === "en" ? en : zh,
				) ?? key,
	};
});

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
const animations: Array<
	Animation & { finish: () => void; node: Element; frames: Keyframe[]; timing: KeyframeAnimationOptions }
> = [];
function mount() {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		return {
			x: 0,
			y: 0,
			width: this.tagName === "svg" ? 500 : 180,
			height: 24,
			top: 0,
			bottom: 24,
			left: this.tagName === "svg" ? 188 : 0,
			right: this.tagName === "svg" ? 688 : 180,
			toJSON() {},
		} as DOMRect;
	});
	vi.spyOn(Element.prototype, "animate").mockImplementation(function (this: Element, frames, timing) {
		let resolve!: (value: Animation) => void;
		const animation = {
			node: this,
			frames,
			timing,
			currentTime: 0,
			startTime: 0,
			playState: "running",
			finished: new Promise<Animation>((done) => {
				resolve = done;
			}),
			play() {
				this.playState = "running";
			},
			pause() {
				this.playState = "paused";
			},
			cancel: vi.fn(),
			finish() {
				this.playState = "finished";
				resolve(this as unknown as Animation);
			},
		};
		animations.push(animation as unknown as (typeof animations)[number]);
		return animation as unknown as Animation;
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
}
function item(name: string, extras: Partial<UIToolCall> = {}, thinking = false): MetaItem {
	const tool: UIToolCall = {
		key: "call",
		id: "call",
		name,
		args: "{}",
		output: "",
		state: "running",
		blockIndex: 0,
		...extras,
	};
	const activity: ActivityEntry[] = [{ id: "c0", kind: "tool", name, args: tool.args }];
	if (thinking) activity.push({ id: "t1", kind: "thinking", text: "private reasoning" });
	return { sourceId: "message", thinking: thinking ? "private reasoning" : "", tools: [tool], activity };
}
async function render(
	value: MetaItem,
	props: { working?: boolean; endImmediately?: boolean; viewKey?: string } = {},
) {
	await act(() => root?.render(<MetaGroup items={[value]} working {...props} />));
}
function text() {
	return host?.querySelector("summary")?.textContent;
}
async function finish() {
	const controller = [...animations]
		.reverse()
		.find(
			(animation) =>
				animation.playState !== "finished" &&
				(animation.node.classList.contains("activity-status-words") ||
					animation.node.classList.contains("activity-status-label")),
		);
	expect(controller).toBeDefined();
	await act(() => controller?.finish());
}
afterEach(async () => {
	await act(() => root?.unmount());
	host?.remove();
	animations.length = 0;
	locale.language = "en";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("keeps only the newest candidate until the entire joined pass ends", async () => {
	mount();
	await render(item("read"));
	expect(text()).toBe("Reviewing relevant content");
	expect(animations[0]?.timing).toMatchObject({ duration: 600, easing: "ease-in-out" });
	await render(item("write"));
	await render(item("webfetch"));
	expect(text()).toBe("Reviewing relevant content");
	expect(animations).toHaveLength(1);
	await finish();
	const pass = animations.slice(-3);
	expect(pass).toHaveLength(3);
	expect(pass.map((a) => a.timing.duration)).toEqual([2356, 2356, 2356]);
	expect(new Set(pass.map((a) => a.startTime)).size).toBe(1);
	await render(item("todo"));
	expect(text()).toBe("Reviewing relevant content");
	expect(animations).toHaveLength(4);
	await finish();
	expect(text()).toBe("Editing TODO content");
	expect(animations.at(-1)?.timing.duration).toBe(600);
});

it("does not re-enter when different tools resolve to the same text", async () => {
	mount();
	await render(item("read"));
	await finish();
	await render(item("grep"));
	await finish();
	expect(text()).toBe("Reviewing relevant content");
	expect(animations.filter((a) => a.timing.duration === 600)).toHaveLength(1);
});

it("uses actual execution time and withdraws a waiting candidate before it can enter", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	mount();
	await render(item("codemode", { startedAt: 1000 }));
	await finish();
	await act(() => vi.advanceTimersByTime(10001));
	expect(text()).toBe("Running a command");
	await render(item("codemode", { startedAt: 1000, endedAt: 11002, state: "done" }));
	await finish();
	expect(text()).not.toBe("Waiting for the command to finish");
});

it("rechecks elapsed execution time on focus even before a throttled deadline fires", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	mount();
	await render(item("codemode", { startedAt: 1000 }));
	await finish();
	vi.setSystemTime(11001);
	await act(() => window.dispatchEvent(new Event("focus")));
	await finish();
	expect(text()).toBe("Waiting for the command to finish");
});

it("only promotes sustained thinking after a complete pass without a running tool", async () => {
	mount();
	await render(item("read"));
	await finish();
	await render(item("read", { state: "done", endedAt: 10 }, true));
	await finish();
	expect(text()).toBe("Reviewing relevant content");
	await finish();
	expect(text()).toBe("Thinking");
});

it.each(["done", "running"] as const)(
	"committed %s tool remains the thinking fallback across message boundaries",
	async (state) => {
		mount();
		const before = { ...emptyTranscript(), agentActive: true };
		before.messages = [
			{
				kind: "assistant",
				id: "previous",
				text: "",
				thinking: "",
				timestamp: 0,
				tools: [{ ...item("read").tools[0]!, state }],
			},
		];
		const draw = async (input: typeof before) => {
			const row = buildChatRows(input, "session").find((row) => row.kind === "metaGroup");
			if (row?.kind !== "metaGroup") throw Error("Missing actual group");
			await act(() => root?.render(<MetaGroup items={row.items} working />));
		};
		await draw(before);
		await finish();
		let input = before;
		for (const event of [
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_start",
					contentIndex: 0,
					partial: { content: [{ type: "thinking", thinking: "" }] },
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reason" },
			},
		])
			input = reduceEvent(input, event as AgentSessionEvent);
		await draw(input);
		await finish();
		expect(text()).toBe("Reviewing relevant content");
		await finish();
		expect(text()).toBe(state === "running" ? "Reviewing relevant content" : "Thinking");
	},
);

it("switches current and candidate language without prematurely consuming the candidate", async () => {
	mount();
	await render(item("read"));
	await finish();
	await render(item("write"));
	locale.language = "zh";
	await render(item("write"));
	expect(text()).toBe("正在查看相关内容");
	await finish();
	expect(text()).toBe("正在编辑相关文件");
});

it.each([
	["en", "Running a command", "Waiting for the command to finish"],
	["zh", "正在执行命令", "正在等待命令执行完成"],
])(
	"%s command threshold and a new same-name call use independent clocks",
	async (language, running, waiting) => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		vi.spyOn(window, "matchMedia").mockReturnValue({
			matches: true,
			addEventListener() {},
			removeEventListener() {},
		} as unknown as MediaQueryList);
		locale.language = language;
		mount();
		await render(item("codemode", { startedAt: 1000 }));
		await act(() => vi.advanceTimersByTime(9999));
		expect(text()).toBe(running);
		await act(() => vi.advanceTimersByTime(1));
		expect(text()).toBe(running);
		await act(() => vi.advanceTimersByTime(1));
		expect(text()).toBe(waiting);
		await render(item("codemode", { key: "next", id: "next", startedAt: Date.now() }));
		expect(text()).toBe(running);
		await act(() => vi.advanceTimersByTime(10000));
		expect(text()).toBe(running);
		await act(() => vi.advanceTimersByTime(1));
		expect(text()).toBe(waiting);
	},
);

it("ignores old playback completion after switching scope", async () => {
	mount();
	await render(item("read"), { viewKey: "old" });
	const old = animations[0];
	await render(item("write"), { viewKey: "new" });
	expect(text()).toBe("Editing relevant files");
	await act(() => old?.finish());
	expect(text()).toBe("Editing relevant files");
});

it("pauses on blur, resumes on focus and hides only particles while expanded", async () => {
	mount();
	await render(item("read"));
	await finish();
	const pass = animations.slice(-3);
	vi.mocked(document.hasFocus).mockReturnValue(false);
	await act(() => window.dispatchEvent(new Event("blur")));
	expect(pass.map((a) => a.playState)).toEqual(["paused", "paused", "paused"]);
	vi.mocked(document.hasFocus).mockReturnValue(true);
	await act(() => window.dispatchEvent(new Event("focus")));
	expect(pass.map((a) => a.playState)).toEqual(["running", "running", "running"]);
	const summary = host?.querySelector("summary");
	const particles = host?.querySelector<SVGElement>(".status-particles");
	await act(async () => {
		summary?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await Promise.resolve();
	});
	expect(particles?.style.visibility).toBe("hidden");
	expect(pass.map((a) => a.playState)).toEqual(["running", "paused", "paused"]);
	await act(async () => {
		summary?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await Promise.resolve();
	});
	expect(particles?.style.visibility).toBe("");
	expect(pass.map((a) => a.playState)).toEqual(["running", "running", "running"]);
});

it("applies reduced motion during playback and ignores its old completion", async () => {
	let onChange: (() => void) | undefined;
	const media = {
		matches: false,
		addEventListener: (_: string, fn: () => void) => {
			onChange = fn;
		},
		removeEventListener() {},
	};
	vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
	mount();
	await render(item("read"));
	const old = animations[0];
	await render(item("write"));
	media.matches = true;
	await act(() => onChange?.());
	expect(text()).toBe("Editing relevant files");
	expect(old?.cancel).toHaveBeenCalled();
	await act(() => old?.finish());
	expect(text()).toBe("Editing relevant files");
});

it("immediately settles and cancels playback even during entry", async () => {
	mount();
	await render(item("read"));
	const old = animations[0];
	await render(item("read", { state: "done", endedAt: 1 }), { working: false, endImmediately: true });
	expect(host?.querySelector(".status-particles")).toBeNull();
	expect(old?.cancel).toHaveBeenCalled();
	await act(() => old?.finish());
	expect(host?.querySelector(".status-particles")).toBeNull();
});
