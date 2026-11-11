// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	state: { bySession: {} as Record<string, unknown>, resolveExtensionDialog: () => {} },
}));
vi.mock("../../stores/transcript", () => ({
	useTranscriptStore: (select: (s: typeof store.state) => unknown) => select(store.state),
}));
vi.mock("../../stores/interactions", () => ({ useCanAnswerInteraction: () => true }));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => ({ respondExtensionDialog: vi.fn() }) }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { InteractionDock } from "./InteractionDock";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

// ask_user_question 的多选题在 RPC 模式下把问题、选项和输入说明拼成一个多行标题
const MULTI_TITLE =
	"[范围] 第一阶段要包含哪些部分？\n\n1. 后端接口 — 新增方法\n2. 界面按钮 — 行内更新\n\n输入编号，用逗号分隔";

it("keeps every line of a multi-line dialog title instead of truncating it to one line", () => {
	store.state.bySession = {
		s: {
			pendingDialogs: [
				{ id: "d", sessionId: "s", kind: "input", title: MULTI_TITLE, requestedAt: Date.now() },
			],
		},
	};
	act(() => root.render(<InteractionDock sessionId="s" />));
	const title = host.querySelector('[role="dialog"] h3') as HTMLElement;
	expect(title.textContent).toBe(MULTI_TITLE);
	expect(title.className).not.toMatch(/\btruncate\b/);
	expect(title.className).toMatch(/\bwhitespace-pre-wrap\b/);
	// 极长标题在自身内部滚动，输入框和按钮不被挤出卡片
	expect(title.className).toMatch(/\bmax-h-\[40vh\]/);
	expect(title.className).toMatch(/\boverflow-y-auto\b/);
	expect(host.querySelector('[role="dialog"] input')).not.toBeNull();
});
