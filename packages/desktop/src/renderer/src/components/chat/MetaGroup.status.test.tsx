// @vitest-environment happy-dom
import {
	type AgentSessionEvent,
	buildChatRows,
	emptyTranscript,
	reduceEvent,
	type StreamingState,
} from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";
import { MetaGroup } from "./MetaGroup";

vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <span data-orb="" /> }));

const locale = vi.hoisted(() => ({ language: "zh" as "zh" | "en" }));
vi.mock("../../i18n", async () => {
	const { en } = await import("../../i18n/en");
	const { zh } = await import("../../i18n/zh");
	return {
		useI18nStore: (select: (state: typeof locale) => unknown) => select(locale),
		useT: () => (key: string) =>
			key
				.split(".")
				.reduce<unknown>(
					(node, part) => (node as Record<string, unknown>)?.[part],
					locale.language === "zh" ? zh : en,
				) ?? key,
	};
});

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing expected element or root");
	return value;
}

beforeEach(() => {
	vi.spyOn(window, "matchMedia").mockReturnValue({
		matches: true,
		addEventListener() {},
		removeEventListener() {},
	} as unknown as MediaQueryList);
});

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
	await act(() => root?.unmount());
	container?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it.each([
	["read", "", "正在查看相关内容", "Reviewing relevant content"],
	["ls", "", "正在查看相关内容", "Reviewing relevant content"],
	["glob", "", "正在查看相关内容", "Reviewing relevant content"],
	["find", "", "正在查看相关内容", "Reviewing relevant content"],
	["grep", "", "正在查看相关内容", "Reviewing relevant content"],
	["edit", "", "正在编辑相关文件", "Editing relevant files"],
	["write", "", "正在编辑相关文件", "Editing relevant files"],
	["codemode", "", "正在执行命令", "Running a command"],
	["webfetch", "", "正在联网查询", "Searching online"],
	["todo", "", "正在编辑 TODO 内容", "Editing TODO content"],
	["tool_search", "", "正在查找可用工具", "Finding available tools"],
	["search_pi_packages", "", "正在查找相关扩展", "Finding relevant extensions"],
	["channel_read", "", "读取频道消息", "Reading channel messages"],
	["channel_post", "", "发送频道消息", "Sending channel messages"],
	["channel_manage", "", "管理频道", "Managing channels"],
	["channel_subscribe", "", "订阅频道", "Subscribing to a channel"],
	["channel_unsubscribe", "", "退订频道", "Unsubscribing from a channel"],
	["channel_list", "", "查看频道列表", "Listing channels"],
	["mcp__server__tool", "", "server › tool", "server › tool"],
	["bash", '{"command":"npm test"}', "正在运行项目测试", "Running project tests"],
	["bash", '{"command":"pnpm run typecheck"}', "正在检查代码质量", "Checking code quality"],
	["bash", '{"command":"yarn build"}', "正在构建项目", "Building the project"],
	["bash", '{"command":"npm ci"}', "正在安装项目依赖", "Installing project dependencies"],
	["bash", '{"command":"git diff"}', "正在查看项目改动", "Reviewing project changes"],
	["bash", '{"command":"git commit"}', "正在记录本次修改", "Committing changes"],
	[
		"bash",
		JSON.stringify({ command: 'git commit -m "fix status flow"' }),
		"正在记录本次修改",
		"Committing changes",
	],
	["bash", JSON.stringify({ command: "npx vitest run" }), "正在运行项目测试", "Running project tests"],
	["bash", JSON.stringify({ command: "vite build" }), "正在构建项目", "Building the project"],
	["bash", JSON.stringify({ command: "biome init" }), "正在执行命令", "Running a command"],
	["bash", JSON.stringify({ command: 'git" status"' }), "正在执行命令", "Running a command"],
	["bash", '{"command":"npm run dev"}', "正在启动开发服务", "Starting the development server"],
	["bash", '{"command":"git log -- test"}', "正在执行命令", "Running a command"],
	["bash", '{"command":"npm run mystery-build"}', "正在执行命令", "Running a command"],
	["bash", '{"command":"npm test && npm build"}', "正在执行命令", "Running a command"],
	["bash", '{"command":"npm test"', "正在执行命令", "Running a command"],
] as const)("真实投影的 %s %s 双语摘要", async (name, args, chinese, english) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const streaming: StreamingState = {
		id: "stream",
		text: "",
		thinking: "",
		pendingImages: [],
		subagentRuns: [],
		subagentByToolCallId: {},
		activeToolIndex: 0,
		toolByContentIndex: {},
		rawToolOutputs: {},
		textBlockIndex: null,
		tools: [{ key: "1", id: "1", name, args, output: "content", state: "running" }],
		activity: [{ id: "c0", kind: "tool", name, args }],
	};
	const row = buildChatRows(
		{ messages: [], streaming, agentActive: true, compacting: false },
		"session",
	).find((r) => r.kind === "metaGroup");
	if (row?.kind !== "metaGroup") throw new Error("Missing projected group");
	for (const [language, expected] of [
		["zh", chinese],
		["en", english],
	] as const) {
		locale.language = language;
		await act(() =>
			required(root).render(<MetaGroup viewKey={language} items={row.items} working={row.working} />),
		);
		expect(required(container.querySelector("summary")).textContent).toBe(expected);
	}
});

it("真实子代理事件投影为独立行并驱动双语摘要，结束后撤销", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const event = (type: string, extra: Record<string, unknown> = {}) =>
		({ type, ...extra }) as AgentSessionEvent;
	let state = reduceEvent(emptyTranscript(), event("agent_start"));
	state = reduceEvent(
		state,
		event("tool_execution_start", {
			toolCallId: "child",
			toolName: "subagent",
			args: { tasks: [{ task: "one" }, { task: "two" }] },
		}),
	);
	state = reduceEvent(
		state,
		event("tool_execution_update", {
			toolCallId: "child",
			toolName: "subagent",
			partialResult: {
				details: {
					results: [
						{ agent: "worker", task: "one", status: "running", exitCode: -1 },
						{ agent: "worker", task: "two", status: "queued", exitCode: -1 },
					],
				},
			},
		}),
	);
	const draw = async () => {
		const rows = buildChatRows(state, "session");
		const row = rows.find((r) => r.kind === "metaGroup");
		if (row?.kind !== "metaGroup") throw new Error("Missing projected group");
		await act(() =>
			required(root).render(
				<MetaGroup
					viewKey={`${row.key}:${locale.language}`}
					items={row.items}
					working={row.working}
					subagentCount={row.subagentCount}
					activeSubagent={row.activeSubagent}
				/>,
			),
		);
		return { rows, row };
	};
	const { rows, row } = await draw();
	expect(rows.some((r) => r.kind === "streamingSubagents")).toBe(true);
	expect(row.items.flatMap((item) => item.tools).some((tool) => tool.name === "subagent")).toBe(false);
	expect(
		row.items
			.flatMap((item) => item.activity ?? [])
			.some((entry) => entry.kind === "tool" && entry.name === "subagent"),
	).toBe(false);
	for (const [language, expected] of [
		["zh", "正在等待子代理任务完成"],
		["en", "Waiting for subagent tasks to finish"],
	] as const) {
		locale.language = language;
		await draw();
		expect(container.querySelector("summary")?.textContent).toBe(expected);
	}
	state = reduceEvent(
		state,
		event("tool_execution_end", {
			toolCallId: "child",
			toolName: "subagent",
			isError: false,
			result: {
				details: {
					results: [
						{ agent: "worker", task: "one", status: "done", exitCode: 0 },
						{ agent: "worker", task: "two", status: "done", exitCode: 0 },
					],
				},
			},
		}),
	);
	const ended = await draw();
	expect(ended.row.activeSubagent).toBeUndefined();
	expect(container.querySelector("summary")?.textContent).not.toBe("Waiting for subagent tasks to finish");
});

it("图片和组合包装不覆盖有效摘要，展开保留原始工具详情", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	locale.language = "en";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const tools = ["read", "show_image", "parallel"].map((name, i) => ({
		key: `${i}`,
		id: `${i}`,
		name,
		args: '{"path":"private-file"}',
		output: "original-output",
		state: "running" as const,
	}));
	const streaming: StreamingState = {
		id: "stream",
		text: "",
		thinking: "",
		pendingImages: [],
		subagentRuns: [],
		subagentByToolCallId: {},
		activeToolIndex: 2,
		toolByContentIndex: {},
		rawToolOutputs: {},
		textBlockIndex: null,
		tools,
		activity: tools.map((tool) => ({ id: tool.id, kind: "tool" as const, name: tool.name, args: tool.args })),
	};
	const row = buildChatRows(
		{ messages: [], streaming, agentActive: true, compacting: false },
		"session",
	).find((r) => r.kind === "metaGroup");
	if (row?.kind !== "metaGroup") throw new Error("Missing projected group");
	await act(() => required(root).render(<MetaGroup items={row.items} working />));
	const summary = required(container.querySelector("summary"));
	expect(summary.textContent).toBe("Reviewing relevant content");
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	const detail = required(container.querySelector("details details summary"));
	expect(detail.textContent).toContain("Read");
	await act(() => detail.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(container.textContent).toContain("private-file");
	expect(container.textContent).toContain("original-output");
});

it("减少动态时立即同步最新摘要，等待间隙不伪装思考", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	locale.language = "zh";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const thinking = { id: "thinking", kind: "thinking" as const, text: "reason" };
	const first = { id: "first", kind: "tool" as const, name: "first_tool", args: "first arg" };
	const second = { id: "second", kind: "tool" as const, name: "second_tool", args: "second arg" };
	const render = async (activity: (typeof thinking | typeof first)[], working = true) => {
		if (!root) throw new Error("Missing root");
		await act(() =>
			root?.render(<MetaGroup items={[{ thinking: "", tools: [], activity }]} working={working} />),
		);
	};
	await render([]);
	expect(container.textContent).toContain(zh.message.working);
	await render([thinking]);
	expect(container.textContent).toContain(zh.message.activity.thinking);
	await render([thinking, first]);
	expect(container.textContent).not.toContain(zh.message.activity.thinking);
	expect(container.textContent).toContain("first_tool");
	expect(container.textContent).not.toContain("first arg");
	const summary = required(container.querySelector("summary"));
	const particles = required(summary.querySelector('svg[aria-hidden="true"]'));
	await render([thinking, first, second]);
	expect(container.textContent).toContain("second_tool");
	expect(container.textContent).not.toContain("second arg");
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	expect(summary.textContent).not.toContain("first_tool");
	await act(() => vi.advanceTimersByTime(1000));
	expect(container.textContent).toContain("second_tool");
	await render([], false);
	expect(container.textContent).not.toContain(zh.message.activity.thinking);
	await render([thinking]);
	expect(container.textContent).toContain(zh.message.activity.thinking);
	expect(summary.textContent).not.toContain("reason");
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
});

it.each(["zh", "en"] as const)("%s 工具标题、粒子与完整详情展开交互", async (language) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	locale.language = language;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const tool = {
		key: "1",
		id: "1",
		name: "custom_tool",
		args: "argument-value",
		output: "output-value",
		state: "running" as const,
	};
	const items = [
		{
			thinking: "",
			tools: [tool],
			activity: [{ id: "a", kind: "tool" as const, name: tool.name, args: tool.args }],
		},
	];
	await act(() => required(root).render(<MetaGroup items={items} working />));
	const summary = required(container.querySelector("summary"));
	expect(summary.textContent).not.toContain((language === "zh" ? zh : en).message.working);
	expect(summary.textContent).toContain("custom_tool");
	expect(summary.textContent).not.toContain("argument-value");
	expect(summary.querySelector("[data-orb]")).not.toBeNull();
	expect(container.querySelector(".meta-dot-running")).not.toBeNull();
	const name = required(summary.querySelector(".activity-status-label"));
	const particles = required(summary.querySelector('svg[aria-hidden="true"]'));
	expect(name.classList.contains("font-bold")).toBe(true);
	expect(required(name.parentElement).textContent).not.toContain("argument-value");
	expect(particles.classList.contains("status-particles")).toBe(true);
	expect(particles.classList.contains("font-bold")).toBe(false);
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(summary.closest("details")?.open).toBe(true);
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	expect(summary.textContent).toContain("custom_tool");
	const detail = required(container.querySelector("details details summary"));
	await act(() => detail.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(container.textContent).toContain("argument-value");
	expect(container.textContent).toContain("output-value");
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	expect(summary.closest("details")?.open).toBe(false);
	const thinking = [
		{ thinking: "", tools: [], activity: [{ id: "think", kind: "thinking" as const, text: "reason" }] },
	];
	await act(() => required(root).render(<MetaGroup items={thinking} working />));
	const label = required(summary.querySelector(".activity-status-label"));
	expect(label.classList.contains("font-bold")).toBe(name.classList.contains("font-bold"));
	await act(() => required(root).render(<MetaGroup items={items} working />));
	expect(summary.textContent).not.toContain((language === "zh" ? zh : en).message.working);
	const finished = [
		{
			thinking: "",
			tools: [
				{ ...tool, state: "done" as const },
				{ ...tool, key: "2", id: "2", state: "done" as const },
			],
		},
	];
	await act(() => required(root).render(<MetaGroup items={finished} working={false} endImmediately />));
	expect(summary.textContent).not.toContain((language === "zh" ? zh : en).message.activity.thinking);
	expect(summary.textContent).toContain("custom_tool");
	expect(summary.textContent).toContain("2");
	expect(container.querySelectorAll(".meta-dot-running")).toHaveLength(0);
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBeNull();
});

it("保留短间隙缓冲，真实结束立即撤下粒子；完整思考仍按需展开", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	locale.language = "zh";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const item = {
		thinking: "full thinking value",
		tools: [],
		activity: [{ id: "think", kind: "thinking" as const, text: "full thinking value" }],
	};
	const render = (working: boolean, endImmediately = false) =>
		act(() =>
			required(root).render(<MetaGroup working={working} endImmediately={endImmediately} items={[item]} />),
		);
	await render(true);
	const summary = required(container.querySelector("summary"));
	const particles = required(summary.querySelector('svg[aria-hidden="true"]'));
	expect(summary.textContent).not.toContain("full thinking value");
	await render(false);
	await act(() => vi.advanceTimersByTime(1499));
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	await render(true);
	await act(() => vi.advanceTimersByTime(10));
	expect(summary.querySelector('svg[aria-hidden="true"]')).toBe(particles);
	await act(() => summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	const thinkingSummary = required(container.querySelector("details details summary"));
	await act(() =>
		thinkingSummary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
	);
	expect(container.textContent).toContain("full thinking value");
	await render(false, true);
	expect(particles.isConnected).toBe(false);
});
