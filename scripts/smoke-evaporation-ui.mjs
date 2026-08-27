#!/usr/bin/env node
// 蒸发转正冒烟：二态控件渲染 + 全新 settings.json → 默认 evaporation + 切 off/回切写侧清遗留键
// + 派生回读与 UI 选中态一致（CDP，agent-dev 隔离目录，全程不动 ~/.pi/agent）
// 前置：dev 实例已带 --remote-debugging-port=9224 运行
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const wsUrl = execSync(
	`curl -s http://127.0.0.1:9224/json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const p=j.find(x=>x.type==='page');console.log(p.webSocketDebuggerUrl)})"`,
)
	.toString()
	.trim();
const { WebSocket } = await import("ws");
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
ws.on("message", (data) => {
	const msg = JSON.parse(data.toString());
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
});
await new Promise((r) => ws.on("open", r));
function send(method, params = {}) {
	return new Promise((resolve) => {
		const mid = ++id;
		pending.set(mid, resolve);
		ws.send(JSON.stringify({ id: mid, method, params }));
	});
}
async function evalJs(expr) {
	const result = await send("Runtime.evaluate", {
		expression: expr,
		returnByValue: true,
		awaitPromise: true,
	});
	if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
	return result.result?.result?.value;
}

const settingsFile = `${process.env.HOME}/.pi/agent-dev/settings.json`;
const backupFile = `${settingsFile}.smoke-bak`;
const readKeys = () => {
	if (!existsSync(settingsFile)) return { acp: "(missing file)", evap: undefined };
	const raw = JSON.parse(readFileSync(settingsFile, "utf8"));
	return {
		acp: Object.hasOwn(raw, "acpCompressionEnabled") ? raw.acpCompressionEnabled : "(absent)",
		evap: raw.contextEvaporation?.enabled === undefined ? "(missing)" : raw.contextEvaporation.enabled,
	};
};

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 定位「上下文管理」行的模式按钮与 hint */
const readRow = () =>
	evalJs(`(() => {
		const h3 = [...document.querySelectorAll("h3")].find(h => h.textContent.includes("上下文管理") || h.textContent.includes("Context management"));
		if (!h3) return null;
		const row = h3.closest("div").parentElement;
		const btns = [...row.querySelectorAll("button")];
		const hint = row.querySelector("p");
		return {
			labels: btns.map(b => ({ t: b.textContent.trim(), sel: b.className.includes("bg-ink") })),
			hint: hint ? hint.textContent.trim().slice(0, 60) : null,
		};
	})()`);

// 0. 备份现场并构造「全新 settings.json」（无任何 key），等 backend 2s 模式缓存过期
if (existsSync(settingsFile)) copyFileSync(settingsFile, backupFile);
writeFileSync(settingsFile, "{}\n");
await sleep(2500);

// 1. 打开通用设置面板 + 重拉 store（全新 key 应派生默认 evaporation）
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().openWith("general")`);
await sleep(800);
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().refresh()`);
await sleep(400);
const mode0 = await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().contextManagerMode`);
check("store 初始 mode = evaporation（全新 key 新默认）", mode0 === "evaporation", `got ${mode0}`);

// 2. 二态控件渲染：2 个按钮 + 初始选中蒸发
const ui0 = await readRow();
check(
	"二态控件渲染（2 个按钮，初始选中蒸发）",
	ui0 !== null && ui0.labels.length === 2 && ui0.labels[0].sel === true,
	JSON.stringify(ui0?.labels),
);

// 3. 切 off（走完整 IPC → backend → 原子写）
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().setContextManagerMode("off")`);
await sleep(600);
const keys1 = readKeys();
check(
	"切 off：contextEvaporation.enabled=false 且遗留 acpCompressionEnabled 键不存在",
	keys1.evap === false && keys1.acp === "(absent)",
	JSON.stringify(keys1),
);

// 4. UI 选中态 + hint 切换
const ui1 = await readRow();
const mode1 = await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().contextManagerMode`);
check("store mode = off", mode1 === "off", `got ${mode1}`);
check(
	"UI 选中态切到关闭 + hint 切换",
	ui1.labels[1].sel === true && ui1.hint && ui1.hint !== ui0.hint,
	JSON.stringify({ sel: ui1.labels.map((b) => b.sel), hint: ui1.hint }),
);

// 5. 切回 evaporation
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().setContextManagerMode("evaporation")`);
await sleep(600);
const keys2 = readKeys();
check(
	"切回 evaporation：enabled=true 且不新增 acpCompressionEnabled 键",
	keys2.evap === true && keys2.acp === "(absent)",
	JSON.stringify(keys2),
);
const mode2 = await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().contextManagerMode`);
check("store 回读 evaporation（派生读与写入一致）", mode2 === "evaporation", `got ${mode2}`);

// 6. 关闭面板 + 恢复现场
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().setOpen(false)`);
if (existsSync(backupFile)) {
	copyFileSync(backupFile, settingsFile);
	unlinkSync(backupFile);
} else {
	unlinkSync(settingsFile);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? "\n=== SMOKE PASS ===" : `\n=== SMOKE FAIL (${failed}) ===`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
