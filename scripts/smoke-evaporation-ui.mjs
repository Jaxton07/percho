#!/usr/bin/env node
// P2 dev 冒烟：设置页三态切换 → settings.json 双写 + 派生读 + UI 状态（CDP，agent-dev 隔离目录）
// 前置：dev 实例已带 --remote-debugging-port=9224 运行
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const readKeys = () => {
	const raw = JSON.parse(readFileSync(settingsFile, "utf8"));
	return {
		acp: raw.acpCompressionEnabled === undefined ? "(missing)" : raw.acpCompressionEnabled,
		evap: raw.contextEvaporation?.enabled === undefined ? "(missing)" : raw.contextEvaporation.enabled,
	};
};

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 定位「上下文管理」行的三个模式按钮与 hint */
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

// 1. 打开通用设置面板
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().openWith("general")`);
await sleep(800);

// 2. 三态控件渲染：3 个按钮 + 初始态
const ui0 = await readRow();
check(
	"三态控件渲染（3 个按钮，初始选中智能压缩）",
	ui0 !== null && ui0.labels.length === 3 && ui0.labels[0].sel === true,
	JSON.stringify(ui0?.labels),
);

// 3. store 初始 mode
const mode0 = await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().contextManagerMode`);
check("store 初始 mode = acp（全新 key 回归底线）", mode0 === "acp", `got ${mode0}`);

// 4. 切 evaporation（走完整 IPC → backend → 双写）
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().setContextManagerMode("evaporation")`);
await sleep(600);
const keys1 = readKeys();
check(
	"切 evaporation：settings.json 双写（acp=false, evap=true）",
	keys1.acp === false && keys1.evap === true,
	JSON.stringify(keys1),
);

// 5. store 回读 + UI 选中态 + hint 切换
const mode1 = await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().contextManagerMode`);
const ui1 = await readRow();
check("store mode = evaporation", mode1 === "evaporation", `got ${mode1}`);
check(
	"UI 选中态切到蒸发 + hint 切换",
	ui1.labels[1].sel === true && /蒸发|Evaporation/.test(ui1.labels[1].t) && ui1.hint && ui1.hint !== ui0.hint,
	JSON.stringify({ sel: ui1.labels.map((b) => b.sel), hint: ui1.hint }),
);

// 6. 切 off
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().setContextManagerMode("off")`);
await sleep(600);
const keys2 = readKeys();
check("切 off：双 key 都 false", keys2.acp === false && keys2.evap === false, JSON.stringify(keys2));

// 7. 切回 acp（恢复现场）
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().setContextManagerMode("acp")`);
await sleep(600);
const keys3 = readKeys();
check("切回 acp：acp=true, evap=false", keys3.acp === true && keys3.evap === false, JSON.stringify(keys3));
const mode3 = await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().contextManagerMode`);
check("store 回读 acp（派生读与写入一致）", mode3 === "acp", `got ${mode3}`);

// 8. 关闭面板恢复现场
await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().setOpen(false)`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? "\n=== SMOKE PASS ===" : `\n=== SMOKE FAIL (${failed}) ===`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
