#!/usr/bin/env node
/**
 * 自定义字号（spec/plan：font-size / issue #58）验收脚本
 *
 * **为什么自带样本会话**：默认档「逐像素零差异」（spec D8）是这次大范围机械迁移的唯一安全网，
 * 而比对要求截图内容可复现。若依赖 dev agent dir 里已有的历史会话，两次跑之间用户一旦聊过天，
 * 截图内容就漂了（比对出的差异与字号无关）。所以本脚本自带三个**固定内容**的样本会话
 * （markdown / 代码块 / 工具卡与 diff）、以及一份固定的 ui-state.json，全部只写隔离目录
 * （`~/.pi/agent-dev/` + dev userData），正式 `~/.pi/agent` 与正式 userData 零写入。
 *
 * **用法**（需要 dev 的脚本：`cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224`，
 * 注意 `npm run dev -- --xxx` 会被 npm 吞掉参数）：
 *   node scripts/check-font-size.mjs inventory [outFile]   # 扫描硬编码字号清单（不需要 dev）
 *   node scripts/check-font-size.mjs seed-state            # 写固定 ui-state.json（**必须先停 dev**，首次会备份原文件）
 *   node scripts/check-font-size.mjs restore-state         # 还原 pre-work 偏好（**必须先停 dev**）
 *   node scripts/check-font-size.mjs seed-fixtures         # 写样本会话（**必须先停 dev**）
 *   node scripts/check-font-size.mjs clean-fixtures        # 清样本（**必须先停 dev**）
 *   node scripts/check-font-size.mjs baseline <outDir>     # 5 场景截图 + sha256 清单（dev 需在跑）
 *   node scripts/check-font-size.mjs compare <before> <after>  # 逐像素判等（默认档零差异，spec D8）
 *   node scripts/check-font-size.mjs diff <a.png> <b.png>  # 单图差异统计（像素数/占比/最大通道差/包围盒）
 *
 * 一次完整跑：停 dev → `seed-state` → `seed-fixtures` → 启 dev → `baseline .local/tmp/font-size/before`
 * （目录只在启动时读一次，所以 seed 后必须重启 dev）。
 *
 * 截图为什么是「连续两帧一致才算数」：合成器偶发给陈旧/空白帧（见 docs/PITFALLS.md），
 * 所以逐帧比对 sha256 直到两帧相同；同时脚本先冻结所有 animation/transition/caret，
 * 排除时间相关像素（呼吸灯、过渡、光标闪烁）造成的假差异。
 *
 * 退出码：0 通过 / 1 断言或运行失败 / 2 环境不满足。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const REPO = resolve(import.meta.dirname, "..");
const RENDERER_SRC = join(REPO, "packages/desktop/src/renderer/src");
const DEV_AGENT_DIR = join(homedir(), ".pi/agent-dev");
const DEV_USER_DATA = join(homedir(), "Library/Application Support/@percho/desktop-dev");
const TMP_DIR = join(REPO, ".local/tmp/font-size");
const FIXTURE_MANIFEST = join(TMP_DIR, "fixture-manifest.json");
const UI_STATE_BACKUP = join(TMP_DIR, "ui-state.original.json");
const FIXTURE_CWD = join(TMP_DIR, "fixture-cwd");
const CDP_PORT = process.env.CDP_PORT ?? "9224";
/** 固定视口（CSS px）：太小装不下设定面板，太大让 5 张图过大；两个周期内必须一致 */
const VIEWPORT = { width: 1280, height: 860 };

const fail = (message, code = 1) => {
	console.error(`✗ ${message}`);
	process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* ==========================================================================
 * 1. inventory：硬编码字号清单（与 spec 事实表逐项对账）
 * ========================================================================== */

/** 递归收集 .tsx（跳过 test 与非源码目录不大可能出现的 dist） */
function walkTsx(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walkTsx(full, out);
		else if (name.endsWith(".tsx")) out.push(full);
	}
	return out;
}

const PX_RE = /text-\[([0-9.]+)px\]/g;
const REM_RE = /\btext-(xs|sm|lg)\b/g;

function scanInventory() {
	const px = new Map(); // 值 → 处数
	const pxFiles = new Set();
	const pxSites = [];
	const rem = new Map();
	const remSites = [];
	for (const file of walkTsx(RENDERER_SRC)) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, i) => {
			for (const m of line.matchAll(PX_RE)) {
				px.set(m[1], (px.get(m[1]) ?? 0) + 1);
				pxFiles.add(file);
				pxSites.push({ file: relative(REPO, file), line: i + 1, value: m[1] });
			}
			for (const m of line.matchAll(REM_RE)) {
				rem.set(m[1], (rem.get(m[1]) ?? 0) + 1);
				remSites.push({ file: relative(REPO, file), line: i + 1, value: m[1], text: line.trim() });
			}
		});
	}
	// globals.css：font-size 落在哪一行、挂在哪个选择器上（选择器 = 上一行不以 { 结尾的最近一行）
	const cssPath = join(RENDERER_SRC, "styles/globals.css");
	const cssLines = readFileSync(cssPath, "utf8").split("\n");
	const cssSites = [];
	cssLines.forEach((line, i) => {
		if (!/font-size\s*:/.test(line)) return;
		// 选择器 = 往上找到的第一个以 { 结尾的行（CSS 块的开头）
		let selector = "";
		for (let j = i - 1; j >= 0 && j > i - 40; j--) {
			const prev = cssLines[j].trim();
			if (prev.endsWith("{")) {
				selector = prev.replace(/\s*\{$/, "");
				break;
			}
		}
		cssSites.push({ line: i + 1, value: line.trim(), selector });
	});
	return {
		px: {
			total: [...px.values()].reduce((a, b) => a + b, 0),
			files: pxFiles.size,
			values: [...px.entries()].sort((a, b) => Number(b[0]) - Number(a[0])),
			sites: pxSites,
		},
		rem: { total: remSites.length, values: [...rem.entries()], sites: remSites },
		globalsFontSize: { total: cssSites.length, sites: cssSites },
	};
}

function runInventory(outFile) {
	const inv = scanInventory();
	const out = outFile ?? join(TMP_DIR, "inventory.json");
	mkdirSync(resolve(out, ".."), { recursive: true });
	writeFileSync(out, `${JSON.stringify(inv, null, 2)}\n`, "utf8");
	console.log(`text-[Npx]：${inv.px.total} 处 / ${inv.px.files} 文件 / ${inv.px.values.length} 个值`);
	console.log(`  ${inv.px.values.map(([v, n]) => `${v}px×${n}`).join("  ")}`);
	console.log(`rem 基类：${inv.rem.total} 处（${inv.rem.values.map(([v, n]) => `${v}×${n}`).join(" ")}）`);
	console.log(`globals.css font-size：${inv.globalsFontSize.total} 处`);
	console.log(`→ ${relative(REPO, out)}`);

	// 断言与 spec §7 事实表一致：不一致说明代码变了，比对基准与迁移清单都要重新核对
	const expectedPx = {
		11: 102,
		13: 85,
		12: 57,
		10: 27,
		11.5: 18,
		14: 6,
		15: 5,
		13.5: 3,
		10.5: 3,
		19: 1,
		16: 1,
		12.5: 1,
	};
	const problems = [];
	if (inv.px.total !== 309) problems.push(`text-[Npx] 应为 309 处，实测 ${inv.px.total}`);
	if (inv.px.files !== 59) problems.push(`应为 59 个文件，实测 ${inv.px.files}`);
	for (const [value, count] of Object.entries(expectedPx)) {
		const actual = inv.px.values.find(([v]) => v === value)?.[1] ?? 0;
		if (actual !== count) problems.push(`text-[${value}px] 应为 ${count} 处，实测 ${actual}`);
	}
	if (inv.rem.total !== 18) problems.push(`rem 基类应为 18 处，实测 ${inv.rem.total}`);
	if (inv.globalsFontSize.total !== 46)
		problems.push(`globals.css font-size 应为 46 处，实测 ${inv.globalsFontSize.total}`);
	if (problems.length > 0) {
		for (const p of problems) console.error(`✗ ${p}`);
		fail("inventory 与 spec §7 事实表不一致：先确认代码是否被改过，再更新事实表与迁移清单");
	}
	console.log("✓ inventory 与 spec §7 事实表逐项一致");
}

/* ==========================================================================
 * 2. 样本会话（固定内容 fixtures）
 * ========================================================================== */

/** 会话目录名编码（与 SDK session-manager 一致：去掉首个 / 后把 / 与 : 换成 -，两侧包 --） */
const sessionDirFor = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const entryId = (n) => n.toString(16).padStart(8, "0");
/** 文件名前缀：ISO 时间，冒号与点换 -（与真实文件名同形） */
const isoForFile = (iso) => iso.replace(/[:.]/g, "-");

const MARKDOWN_SAMPLE = [
	"## 二级标题 Sample Heading",
	"",
	"这是一段中文正文，混排 English words 与数字 1234，用来验证界面字号是否整体跟随。",
	"",
	"### 三级标题",
	"",
	"- 列表项一：`inlineCode()` 内联代码",
	"- 列表项二：**加粗** 与 *斜体*",
	"",
	"1. 有序项一",
	"2. 有序项二",
	"",
	"> 引用行：字号变化时行高应等比例跟随，不得出现裁切。",
	"",
	"| 列 A | 列 B（较长） |",
	"| --- | --- |",
	"| 值 1 | 值 2 |",
	"| 值 3 | 值 4 |",
	"",
	"---",
	"",
	"末尾段落：行内 `code` 与 [链接](https://example.com) 一起出现。",
].join("\n");

const CODE_SAMPLE = [
	"代码块与内联 `inlineCode()` 的字号基线。",
	"",
	"```ts",
	"export function computeScale(base: number, preset: number): number {",
	"  const scale = preset / base;",
	"  return Math.round(scale * 1000) / 1000;",
	"}",
	"",
	'const veryLongLine = "一段很长的字符串，用来验证横向滚动与断行行为在字号变化后仍然正常，abcdefghijklmnopqrstuvwxyz0123456789";',
	"```",
	"",
	"```python",
	"def clamp(value, low, high):",
	"    return max(low, min(value, high))",
	"```",
].join("\n");

const FIXTURE_PATCH = [
	"--- a/packages/desktop/src/renderer/src/styles/typography.css",
	"+++ b/packages/desktop/src/renderer/src/styles/typography.css",
	"@@ -1,6 +1,7 @@",
	" :root {",
	" \t--fs-ui-scale: 1;",
	"+\t--fs-code-scale: 1;",
	" }",
	" ",
	" /* 字号表（唯一事实源）：新增字号只在这里加 */",
	"",
].join("\n");

/** 三个样本会话：内容固定、id 固定、时间戳固定（顺序与截图内容都不随用户使用而漂移） */
const FIXTURES = [
	{
		key: "markdown",
		sessionId: "01a0ffff-fontsize-baseline-0000-000000000001",
		name: "字号基线 · markdown",
		iso: "2026-10-07T10:00:00.000Z",
		user: "markdown 样本：标题 / 列表 / 引用 / 表格 / 内联代码",
		assistant: MARKDOWN_SAMPLE,
	},
	{
		key: "code",
		sessionId: "01a0ffff-fontsize-baseline-0000-000000000002",
		name: "字号基线 · 代码块",
		iso: "2026-10-07T10:05:00.000Z",
		user: "代码样本：monaco 代码块 + 内联 code + 长行",
		assistant: CODE_SAMPLE,
	},
	{
		key: "tools",
		sessionId: "01a0ffff-fontsize-baseline-0000-000000000003",
		name: "字号基线 · 工具卡与 diff",
		iso: "2026-10-07T10:10:00.000Z",
		user: "工具样本：bash + edit（带 patch）",
		assistant: "改了一下 `typography.css`，另外跑了 git status。",
		tools: [
			{
				name: "bash",
				toolCallId: "call_fontsize_fixture_bash_0001",
				args: { command: "git status --short" },
				output: " M packages/desktop/src/renderer/src/styles/typography.css",
			},
			{
				name: "edit",
				toolCallId: "call_fontsize_fixture_edit_0002",
				args: {
					path: "packages/desktop/src/renderer/src/styles/typography.css",
					edits: [{ oldText: "\t--fs-ui-scale: 1;", newText: "\t--fs-ui-scale: 1;\n\t--fs-code-scale: 1;" }],
				},
				output:
					"Successfully replaced 1 block(s) in packages/desktop/src/renderer/src/styles/typography.css.",
				details: { patch: FIXTURE_PATCH, firstChangedLine: 2 },
			},
		],
	},
];

function fixtureFile(fixture) {
	return join(
		DEV_AGENT_DIR,
		"sessions",
		sessionDirFor(FIXTURE_CWD),
		`${isoForFile(fixture.iso)}_${fixture.sessionId}.jsonl`,
	);
}

/** 样本会话说到底就是一份 jsonl：header + session_info + user/assistant/toolResult 条目 */
function buildFixtureLines(fixture) {
	const at = Date.parse(fixture.iso);
	const lines = [
		{ type: "session", version: 3, id: fixture.sessionId, timestamp: fixture.iso, cwd: FIXTURE_CWD },
		{ type: "session_info", id: entryId(1), parentId: null, timestamp: fixture.iso, name: fixture.name },
		{
			type: "message",
			id: entryId(2),
			parentId: entryId(1),
			timestamp: fixture.iso,
			message: { role: "user", content: [{ type: "text", text: fixture.user }], timestamp: at },
		},
	];
	let entry = 3;
	let parent = entryId(2);
	let clock = at + 1000;
	const push = (message) => {
		lines.push({
			type: "message",
			id: entryId(entry),
			parentId: parent,
			timestamp: new Date(clock).toISOString(),
			message,
		});
		parent = entryId(entry);
		entry += 1;
	};
	for (const tool of fixture.tools ?? []) {
		push({
			role: "assistant",
			content: [{ type: "toolCall", id: tool.toolCallId, name: tool.name, arguments: tool.args }],
			timestamp: clock,
		});
		clock += 10;
		push({
			role: "toolResult",
			toolCallId: tool.toolCallId,
			toolName: tool.name,
			content: [{ type: "text", text: tool.output }],
			...(tool.details ? { details: tool.details } : {}),
			isError: false,
			timestamp: clock,
		});
		clock += 10;
	}
	push({ role: "assistant", content: [{ type: "text", text: fixture.assistant }], timestamp: clock });
	return lines;
}

function seedFixtures() {
	if (existsSync(FIXTURE_MANIFEST)) {
		fail(
			`样本清单已存在（${relative(REPO, FIXTURE_MANIFEST)}）：已 seed 过或上次没清干净，先 clean-fixtures`,
		);
	}
	if (!existsSync(DEV_AGENT_DIR)) fail(`dev agent dir 不存在：${DEV_AGENT_DIR}（先跑一次 dev）`, 2);
	mkdirSync(FIXTURE_CWD, { recursive: true });
	const files = [];
	for (const fixture of FIXTURES) {
		const file = fixtureFile(fixture);
		if (existsSync(file)) fail(`样本文件已存在（${relative(REPO, file)}）：人工确认后删除再 seed`);
		mkdirSync(resolve(file, ".."), { recursive: true });
		const content = `${buildFixtureLines(fixture)
			.map((line) => JSON.stringify(line))
			.join("\n")}\n`;
		writeFileSync(file, content, "utf8");
		files.push({ key: fixture.key, sessionId: fixture.sessionId, file });
	}
	writeFileSync(
		FIXTURE_MANIFEST,
		`${JSON.stringify({ kind: "font-size-baseline-fixtures", version: 1, cwd: FIXTURE_CWD, files }, null, 2)}\n`,
		"utf8",
	);
	console.log(`已写入 ${files.length} 个样本会话 → ${resolve(files[0].file, "..")}`);
	for (const f of files) console.log(`  ${f.key}: ${f.sessionId}`);
	console.log("样本目录只在启动时读一次：**必须重启 dev** 才可见。用完记得 clean-fixtures。");
}

function cleanFixtures() {
	if (!existsSync(FIXTURE_MANIFEST)) {
		console.log("没有样本清单：幂等 no-op");
		return;
	}
	const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8"));
	if (manifest.kind !== "font-size-baseline-fixtures") fail(`清单 kind 不匹配，拒绝删除：${manifest.kind}`);
	for (const item of manifest.files) {
		if (!existsSync(item.file)) {
			console.log(`  已不存在（跳过）：${item.file}`);
			continue;
		}
		const header = JSON.parse(readFileSync(item.file, "utf8").split("\n")[0]);
		if (header.id !== item.sessionId) fail(`文件头 id 与清单不符，拒绝删除：${item.file}`);
		rmSync(item.file);
		console.log(`  已删除：${relative(REPO, item.file)}`);
	}
	rmSync(FIXTURE_MANIFEST);
	const dir = resolve(manifest.files[0].file, "..");
	if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
	console.log("样本已清理");
}

/* ==========================================================================
 * 3. seed-state：固定 ui-state.json（截图可比性的前提）
 * ========================================================================== */

/**
 * 截图会被这些偏好影响：主题（system 随系统变）、左栏展开态（决定哪些会话行进画面）、
 * 工作区成员（顶栏胶囊）、窗口尺寸。全部钉死，保证 before/after 两次跑的是同一张界面。
 */
function seedState() {
	const file = join(DEV_USER_DATA, "ui-state.json");
	if (!existsSync(DEV_USER_DATA)) fail(`dev userData 不存在：${DEV_USER_DATA}（先跑一次 dev）`, 2);
	// 先备份一次**pre-work 的真实偏好**（只备第一次），收尾时 `restore-state` 原样还回去
	if (!existsSync(UI_STATE_BACKUP)) {
		if (!existsSync(file)) fail(`既没有 ui-state.json 也没有备份：${file}`, 2);
		writeFileSync(UI_STATE_BACKUP, readFileSync(file), "utf8");
		console.log(`已备份原偏好 → ${relative(REPO, UI_STATE_BACKUP)}`);
	}
	const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	const next = {
		...current,
		theme: "light",
		background: { image: null, dim: 0.8 },
		centerOrbEnabled: false,
		pinnedSessions: [],
		sessionPermissionModes: {},
		barSessionsVisible: true,
		sessionRailEnabled: false,
		sessionWorkspace: { files: [], activeFile: null },
		sidebarCollapsed: false,
		sidebarWidth: 240,
		windowBounds: { x: 120, y: 80, width: VIEWPORT.width, height: VIEWPORT.height },
		expandedGroups: [FIXTURE_CWD],
		expandedGroupsTouched: true,
		pinnedProjects: [],
		lastCwd: FIXTURE_CWD,
	};
	writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	console.log(`已 seed ${file}`);
	console.log("注意：页面运行期间会回写覆盖，所以 seed 必须在 dev 停止时做。收尾 `restore-state` 还原。");
}

function restoreState() {
	if (!existsSync(UI_STATE_BACKUP)) fail(`没有备份，无法还原：${relative(REPO, UI_STATE_BACKUP)}`);
	writeFileSync(join(DEV_USER_DATA, "ui-state.json"), readFileSync(UI_STATE_BACKUP), "utf8");
	console.log(`已还原原偏好 → ${join(DEV_USER_DATA, "ui-state.json")}`);
}

/* ==========================================================================
 * 4. CDP
 * ========================================================================== */

async function findPage(timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const list = JSON.parse(execFileSync("curl", ["-s", `http://127.0.0.1:${CDP_PORT}/json`]).toString());
			const found = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
			if (found) return found;
		} catch {
			/* 端口未绑/非 JSON：下一轮 */
		}
		await sleep(400);
	}
	fail(`等不到 page target：dev 是否带 --remote-debugging-port=${CDP_PORT} 在跑？`, 2);
}

async function connect() {
	const page = await findPage();
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	let msgId = 0;
	const pending = new Map();
	ws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (!msg.id || !pending.has(msg.id)) return;
		const { resolve: res, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
	};
	await new Promise((r) => (ws.onopen = r));
	const send = (method, params = {}) =>
		new Promise((res, reject) => {
			const id = ++msgId;
			pending.set(id, { resolve: res, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails)
			throw new Error(`页面内执行失败：${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
		return r.result?.value;
	};
	return { ws, send, evaluate };
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cdp.evaluate(`!!(${expression})`)) return;
		await sleep(120);
	}
	throw new Error(`等待超时：${label}`);
}

/** 冻结所有时间相关像素：动画、过渡、光标闪烁（两次跑都冻，差异才只可能来自字号） */
const FRAME_FIX = `(() => {
	document.documentElement.style.setProperty("--fs-ui-scale", "1");
	document.documentElement.style.setProperty("--fs-code-scale", "1");
	if (!document.getElementById("font-size-check-freeze")) {
		const el = document.createElement("style");
		el.id = "font-size-check-freeze";
		el.textContent = "*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}";
		document.head.appendChild(el);
	}
	return true;
})()`;

const BLUR = `(() => {
	if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	return document.activeElement?.tagName ?? null;
})()`;

const SETTLE = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;

/** toast 是时间相关的浮层（扩展通知 5s 后自己消失）：截图前等它们全部离场，否则两次跑拍的浮层内容/位置可能不同 */
async function waitForNoToasts(cdp) {
	await waitFor(
		cdp,
		`document.querySelectorAll(".toast, .toast-overflow").length === 0`,
		"toast 清空",
		25000,
	);
}

/** 展开页面上所有 details（工具卡与 diff 文件卡都是 details）：闭合的后代虽在 DOM，但画面里看不到 */
const OPEN_ALL_DETAILS = `(() => {
	let closed = 0;
	for (const el of document.querySelectorAll("details:not([open])")) {
		el.open = true;
		closed += 1;
	}
	return closed;
})()`;

/**
 * 把鼠标停到一个「下面没有可 hover 元素」的点上。
 *
 * 为什么必要：真实光标停在窗口里时，鼠标下的行会带 `:hover`（悬停底色 + 浮出的 «⋯»/编辑按钮），
 * 这个状态随「跑脚本时光标恰好在哪」而变 —— 同一份代码两次跑会出现与字号无关的像素差异。
 * 合成一次 mouseMoved 就能把 hover 钉在固定点上（不管真实光标在哪）；顺手挑一个干净的落点
 * （hover 链里没有 group/button/行元素），免得画面里多出悬停底色。
 */
const HOVER_PROBE = `(() => {
	const chain = [...document.querySelectorAll(":hover")];
	const deep = chain[chain.length - 1];
	const bad = [];
	for (const el of chain) {
		const cls = String(el.className || "");
		if (el.matches("button, summary, a, input, details, label, [role='button'], [data-session-id]"))
			bad.push(el.tagName + "." + cls.slice(0, 40));
		else if (/(^|\\s)group(\\/|\\s|$)/.test(cls)) bad.push("hoverable-ancestor:" + cls.slice(0, 40));
	}
	return JSON.stringify({ deep: deep ? deep.tagName + "." + String(deep.className).slice(0, 60) : null, bad });
})()`;

async function parkMouse(cdp, viewport) {
	const candidates = [
		[viewport.width - 8, 500],
		[viewport.width - 40, 300],
		[viewport.width - 120, 700],
		[8, viewport.height - 8],
	];
	let fallback = null;
	for (const [x, y] of candidates) {
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
		await sleep(140);
		const probe = JSON.parse(await cdp.evaluate(HOVER_PROBE));
		if (probe.bad.length === 0) return { x, y, hover: probe.deep, clean: true };
		fallback ??= { x, y, hover: probe.deep, clean: false };
	}
	// 没有完全干净的点也不影响可比性（两次跑停在同一点、hover 态一样），只是画面里会多一块悬停底色
	return fallback;
}

/** 截图：连续两帧 sha256 相同才算稳定（合成器偶发陈旧/空白帧，见 PITFALLS） */
async function captureStable(cdp, file, viewport, attempts = 6) {
	let previous = null;
	for (let i = 0; i < attempts; i++) {
		await sleep(220);
		const { data } = await cdp.send("Page.captureScreenshot", {
			format: "png",
			clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
		});
		const buf = Buffer.from(data, "base64");
		if (buf.length < 25000) {
			console.log(`  第 ${i + 1} 帧疑似空白（${buf.length}B），重试`);
			previous = null;
			continue;
		}
		const hash = sha256(buf);
		if (previous?.hash === hash) {
			writeFileSync(file, buf);
			return { bytes: buf.length, sha256: hash, frames: i + 1 };
		}
		previous = { hash, buf };
	}
	throw new Error(`截图不稳定（${attempts} 次内没有连续两帧一致）：${file}`);
}

/* ==========================================================================
 * 5. baseline：5 个场景
 * ========================================================================== */

const fixtureMeta = (key) => {
	const fixture = FIXTURES.find((f) => f.key === key);
	if (!fixture) throw new Error(`未知样本：${key}`);
	return { sessionFile: fixtureFile(fixture), sessionId: fixture.sessionId, name: fixture.name };
};

/**
 * 「真在画面上」而不仅仅是「在 DOM 里」。**这个区别踩过坑**：diff 侧栏铭在 DOM 里但被 transform
 * 推到视口外（x=1320 > 宽 1280），子节点的 rect 依旧有高度 —— 只查 `querySelector` 会假阳。
 */
const visible = (selector) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.width > 4 && r.height > 4 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
})()`;

async function openFixture(cdp, key) {
	const meta = fixtureMeta(key);
	await cdp.evaluate(
		`window.PerchoUI.stores.useProjectsStore.getState().openSession(${JSON.stringify({
			sessionFile: meta.sessionFile,
			sessionId: meta.sessionId,
		})})`,
	);
	// 等到 store 的 activeSessionId 就是它（内容替换可能晚一点，随后由 marker 等待兜底）
	await waitFor(
		cdp,
		`window.PerchoUI.stores.useSessionsStore.getState().activeSessionId === ${JSON.stringify(meta.sessionId)}`,
		`activeSessionId = ${key}`,
	);
	return meta;
}

/** 5 个场景：覆盖 spec 里最容易被字号迁移漏掉的几类文本 */
const SCENES = [
	{
		id: "01-new-session",
		desc: "主界面空态（新会话页：字标 + 居中输入框 + 项目选择）",
		setup: async (cdp) => {
			await cdp.evaluate(`
				window.PerchoUI.stores.useSettingsStore.getState().setOpen(false);
				window.PerchoUI.stores.useUiStore.getState().setDiffSidebarOpen(false);
				window.PerchoUI.stores.useSessionsStore.getState().activateNewSessionDraft();
			`);
			await waitFor(cdp, visible('[role="img"][aria-label="Percho"]'), "新会话页字标");
		},
	},
	{
		id: "02-markdown",
		desc: "会话页含 markdown（标题 / 列表 / 引用 / 表格 / 内联 code）",
		setup: async (cdp) => {
			const meta = await openFixture(cdp, "markdown");
			await waitFor(cdp, visible(".markdown-body table"), "markdown 表格");
			return { fixture: meta.name };
		},
	},
	{
		id: "03-code",
		desc: "含代码块的消息（monaco 代码块 + 内联 code + 长行）",
		setup: async (cdp) => {
			const meta = await openFixture(cdp, "code");
			await waitFor(cdp, visible(".monaco-editor"), "monaco 代码块");
			return { fixture: meta.name };
		},
	},
	{
		id: "04-settings-appearance",
		desc: "设置面板「外观」页（主题 / 背景 / 开关 / 字号 chip 将来落在这里）",
		setup: async (cdp) => {
			await cdp.evaluate(`window.PerchoUI.stores.useSettingsStore.getState().openWith("appearance")`);
			await waitFor(cdp, visible('[role="dialog"]'), "设置弹窗");
			await waitFor(cdp, `document.querySelectorAll('[role="dialog"] button').length >= 3`, "外观页内容");
		},
	},
	{
		id: "05-tool-diff",
		desc: "含 diff 卡片 / 工具卡的轮次（工具卡展开 + 右侧变更浮层打开）",
		setup: async (cdp) => {
			await cdp.evaluate(`window.PerchoUI.stores.useSettingsStore.getState().setOpen(false)`);
			const meta = await openFixture(cdp, "tools");
			await waitFor(cdp, visible(".turn-diff"), "轮末变更卡");
			// diff 正文在**右侧变更浮层**里（聊天区里的轮末 chip 只有文件行，不展开 diff 正文）
			await cdp.evaluate(`window.PerchoUI.stores.useUiStore.getState().setDiffSidebarOpen(true)`);
			await waitFor(cdp, visible(".diff-sidebar"), "右侧变更浮层");
			// 全开 details：工具卡与 diff 文件卡都是 details；展开会让 React 重挂载子节点，循环到不再有闭合项
			for (let i = 0; i < 6; i++) {
				const closed = await cdp.evaluate(OPEN_ALL_DETAILS);
				if (closed === 0) break;
				await sleep(300);
			}
			await waitFor(cdp, visible(".diff-table, .diff-fallback"), "diff 正文（已展开且在画面上）");
			return { fixture: meta.name };
		},
	},
];

async function runBaseline(outDir) {
	const missing = FIXTURES.filter((f) => !existsSync(fixtureFile(f)));
	if (missing.length > 0)
		fail(`样本会话缺失（${missing.map((m) => m.key).join(", ")}）：先停 dev → seed-fixtures → 启 dev`, 2);
	mkdirSync(outDir, { recursive: true });
	const cdp = await connect();
	await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

	// 固定视口：两轮必须是同一个尺寸，否则整图不可比
	await cdp.evaluate(`window.resizeTo(${VIEWPORT.width}, ${VIEWPORT.height})`);
	await sleep(800);
	const viewport = await cdp
		.evaluate(
			`JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: devicePixelRatio, screenX, screenY, outerWidth, outerHeight })`,
		)
		.then(JSON.parse);
	console.log(
		`视口 ${viewport.width}×${viewport.height}（DPR ${viewport.dpr}）窗口位于 (${viewport.screenX}, ${viewport.screenY}) 外框 ${viewport.outerWidth}×${viewport.outerHeight}` +
			(viewport.width === VIEWPORT.width ? "" : ` ⚠ 宽度与期望 ${VIEWPORT.width} 不符`),
	);

	// 样本是否真的被 app 看见（目录只在启动时读一次）
	const visible = await cdp.evaluate(
		`(async () => { const list = await window.pi.listAllSessions(); return list.map((s) => s.sessionId); })()`,
	);
	const absent = FIXTURES.filter((f) => !visible.includes(f.sessionId));
	if (absent.length > 0)
		fail(`样本会话不在会话列表里（${absent.map((a) => a.key).join(", ")}）：seed 后没重启 dev？`, 2);

	await cdp.evaluate(FRAME_FIX);
	await waitFor(cdp, `document.querySelector(".sidebar")`, "主界面");

	const shots = [];
	for (const scene of SCENES) {
		console.log(`▸ ${scene.id}：${scene.desc}`);
		const extra = (await scene.setup(cdp)) ?? {};
		await waitForNoToasts(cdp);
		await cdp.evaluate(FRAME_FIX); // 场景切换可能带来新挂载的动画/过渡，重新冻结一次
		await cdp.evaluate(BLUR);
		const parked = await parkMouse(cdp, viewport);
		if (!parked.clean)
			console.log(`  ⚠ 没有完全干净的鼠标停点，停于 ${parked.hover}（两次跑一致，不影响可比性）`);
		await cdp.evaluate(SETTLE);
		const file = join(outDir, `${scene.id}.png`);
		const shot = await captureStable(cdp, file, viewport);
		console.log(`  已存 ${scene.id}.png（${Math.round(shot.bytes / 1024)}KB, ${shot.frames} 帧内稳定）`);
		shots.push({ id: scene.id, desc: scene.desc, file, park: parked, ...extra, ...shot });
	}

	await cdp.evaluate(`window.PerchoUI.stores.useSettingsStore.getState().setOpen(false)`);
	cdp.ws.close();

	const manifest = {
		kind: "font-size-baseline",
		version: 1,
		createdAt: new Date().toISOString(),
		gitHead: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO }).toString().trim(),
		viewport,
		shots,
	};
	writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	writeFileSync(
		join(outDir, "sha256.txt"),
		`${shots.map((s) => `${s.sha256}  ${s.id}.png`).join("\n")}\n`,
		"utf8",
	);
	console.log(`\n✓ 5 张基线图 → ${relative(REPO, outDir)}（含 manifest.json 与 sha256.txt）`);
	for (const s of shots) console.log(`  ${s.sha256.slice(0, 16)}  ${s.id}.png`);
	console.log("\n比对：manifest.json 的 viewport 必须一致，逐图 sha256 必须一致（不一致处用像素差异定位）。");
}

/* ==========================================================================
 * 6. compare / diff：两次 baseline 的逐像素判等
 * ========================================================================== */

/**
 * 极简 PNG 解码（零依赖：Node 自带 zlib）：只支持 Chromium `Page.captureScreenshot` 的那种 8bit
 * 非交错 RGB/RGBA。为什么要自己解：判等需要「差了多少像素、差在哪、差多大」——
 * 只有 sha256 时，一个亚像素抗锯齿抖动（实测 3~1200 px / 最大通道差 ≤93）会和一次字号回归长得一样。
 */
function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
	let pos = 8;
	let header = null;
	const idat = [];
	while (pos + 8 <= buf.length) {
		const length = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			header = {
				width: data.readUInt32BE(0),
				height: data.readUInt32BE(4),
				depth: data[8],
				colorType: data[9],
				interlace: data[12],
			};
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + length;
	}
	if (!header) throw new Error("PNG 缺 IHDR");
	if (header.depth !== 8 || header.interlace !== 0) {
		throw new Error(`不支持的 PNG（depth=${header.depth} interlace=${header.interlace}）`);
	}
	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
	if (!channels) throw new Error(`不支持的 PNG colorType=${header.colorType}`);
	const raw = inflateSync(Buffer.concat(idat));
	const { width, height } = header;
	const stride = width * channels;
	const out = Buffer.alloc(width * height * 4, 255);
	let previous = Buffer.alloc(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? line[i - channels] : 0;
			const up = previous[i];
			const upLeft = i >= channels ? previous[i - channels] : 0;
			if (filter === 1) line[i] = (line[i] + left) & 0xff;
			else if (filter === 2) line[i] = (line[i] + up) & 0xff;
			else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				line[i] = (line[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
			} else if (filter !== 0) throw new Error(`未知 PNG filter=${filter}`);
		}
		previous = line;
		for (let x = 0; x < width; x++) {
			const target = (y * width + x) * 4;
			const source = x * channels;
			out[target] = line[source];
			out[target + 1] = channels === 1 || channels === 2 ? line[source] : line[source + 1];
			out[target + 2] = channels === 1 || channels === 2 ? line[source] : line[source + 2];
			out[target + 3] = channels === 4 ? line[source + 3] : channels === 2 ? line[source + 1] : 255;
		}
	}
	return { width, height, data: out };
}

/** 两张同尺寸 PNG 的差异统计：像素数/占比/最大通道差/包围盒（CSS px 与设备 px 都给） */
function pngDiff(fileA, fileB) {
	const a = decodePng(readFileSync(fileA));
	const b = decodePng(readFileSync(fileB));
	if (a.width !== b.width || a.height !== b.height) {
		return { sizeMismatch: true, sizeA: [a.width, a.height], sizeB: [b.width, b.height] };
	}
	let pixels = 0;
	let maxDelta = 0;
	const bbox = [a.width, a.height, -1, -1];
	for (let y = 0; y < a.height; y++) {
		for (let x = 0; x < a.width; x++) {
			const i = (y * a.width + x) * 4;
			const delta = Math.max(
				Math.abs(a.data[i] - b.data[i]),
				Math.abs(a.data[i + 1] - b.data[i + 1]),
				Math.abs(a.data[i + 2] - b.data[i + 2]),
			);
			if (delta === 0) continue;
			pixels += 1;
			if (delta > maxDelta) maxDelta = delta;
			if (x < bbox[0]) bbox[0] = x;
			if (y < bbox[1]) bbox[1] = y;
			if (x > bbox[2]) bbox[2] = x;
			if (y > bbox[3]) bbox[3] = y;
		}
	}
	return {
		sizeMismatch: false,
		width: a.width,
		height: a.height,
		pixels,
		ratio: pixels / (a.width * a.height),
		maxDelta,
		bbox,
	};
}

/**
 * 判「只是渲染器抗锯齿抖动」还是「真差异」。阈值宽：实测抖动 = 3~1200 px / 最大通道差 ≤93
 * （同一份代码、不同 dev 进程间；同进程内 5 帧连续截图逐字节相同），而字号回归会让成千上万像素
 * 同时改（字形变宽/行高变化），远超 0.05%。
 */
const JITTER_LIMIT = { ratio: 0.0005, maxDelta: 128 };

/** 读一份 baseline 的 manifest + 逐图 sha256 */
function readBaseline(dir) {
	const manifestFile = join(dir, "manifest.json");
	if (!existsSync(manifestFile)) fail(`不是 baseline 目录（缺 manifest.json）：${dir}`, 2);
	const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
	const shots = manifest.shots.map((shot) => {
		const file = join(dir, `${shot.id}.png`);
		return { ...shot, file, bytes: statSync(file).size, sha256: sha256(readFileSync(file)) };
	});
	return { manifest, shots };
}

function runCompare(beforeDir, afterDir) {
	const before = readBaseline(resolve(beforeDir));
	const after = readBaseline(resolve(afterDir));
	console.log(`before: ${beforeDir}（HEAD ${before.manifest.gitHead}）`);
	console.log(`after : ${afterDir}（HEAD ${after.manifest.gitHead}）`);
	const va = before.manifest.viewport;
	const vb = after.manifest.viewport;
	if (va.width !== vb.width || va.height !== vb.height || va.dpr !== vb.dpr) {
		fail(`视口不一致（${JSON.stringify(va)} vs ${JSON.stringify(vb)}）：整图不可比`);
	}
	let failed = 0;
	let jitter = 0;
	for (const b of before.shots) {
		const a = after.shots.find((s) => s.id === b.id);
		if (!a) {
			console.log(`✗ ${b.id}：after 缺少这一张`);
			failed += 1;
			continue;
		}
		if (a.sha256 === b.sha256) {
			console.log(`✓ ${b.id} 逐像素一致`);
			continue;
		}
		const stats = pngDiff(b.file, a.file);
		if (stats.sizeMismatch) {
			console.log(`✗ ${b.id} 图尺寸不同（${stats.sizeA} vs ${stats.sizeB}）`);
			failed += 1;
			continue;
		}
		const only = stats.ratio <= JITTER_LIMIT.ratio && stats.maxDelta <= JITTER_LIMIT.maxDelta;
		const detail = `${stats.pixels} px（${(stats.ratio * 100).toFixed(4)}%）最大通道差 ${stats.maxDelta}，包围盒 ${stats.bbox}（设备 px）`;
		if (only) {
			console.log(`⚠ ${b.id} 仅抗锯齿级抖动：${detail} → 判为一致`);
			jitter += 1;
		} else {
			console.log(`✗ ${b.id} 有实质差异：${detail}`);
			failed += 1;
		}
	}
	if (failed > 0) fail(`${failed} 张有实质差异（默认档安全网未过）`);
	console.log(
		jitter > 0
			? `\n✓ 无实质差异（另有 ${jitter} 张仅抗锯齿级抖动，见上）`
			: "\n✓ 全部场景逐像素一致：默认档渲染与改动前零差异",
	);
}

function runDiff(fileA, fileB) {
	const stats = pngDiff(resolve(fileA), resolve(fileB));
	console.log(JSON.stringify(stats, null, 2));
	if (stats.sizeMismatch) fail("两张图尺寸不同");
	const only = stats.ratio <= JITTER_LIMIT.ratio && stats.maxDelta <= JITTER_LIMIT.maxDelta;
	console.log(only ? "判定：仅抗锯齿级抖动" : "判定：实质差异");
}

/* ==========================================================================
 * 入口
 * ========================================================================== */

const [mode, arg, arg2] = process.argv.slice(2);
try {
	switch (mode) {
		case "inventory":
			runInventory(arg);
			break;
		case "seed-fixtures":
			seedFixtures();
			break;
		case "clean-fixtures":
			cleanFixtures();
			break;
		case "seed-state":
			seedState();
			break;
		case "restore-state":
			restoreState();
			break;
		case "baseline":
			if (!arg) fail("baseline 需要 outDir：node scripts/check-font-size.mjs baseline <outDir>", 2);
			await runBaseline(resolve(arg));
			break;
		case "compare":
			if (!arg || !arg2) fail("compare 需要两个目录：compare <beforeDir> <afterDir>", 2);
			runCompare(arg, arg2);
			break;
		case "diff":
			if (!arg || !arg2) fail("diff 需要两张图：diff <a.png> <b.png>", 2);
			runDiff(arg, arg2);
			break;
		default:
			fail(
				"用法：inventory [outFile] | seed-state | restore-state | seed-fixtures | clean-fixtures | baseline <outDir> | compare <beforeDir> <afterDir> | diff <a.png> <b.png>（见文件头）",
				2,
			);
	}
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
process.exit(0);
