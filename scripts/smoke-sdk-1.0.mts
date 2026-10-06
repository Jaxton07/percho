// 阶段 0 冒烟：pi SDK 升级到 1.0.4 的事实核对（9 条断言，硬门）。
// 断言依据：.local/agent-work/plan/pi-sdk-1.0-upgrade-plan.md 阶段 0 + spec §7.2/§7.3。
// 用法：npx tsx scripts/smoke-sdk-1.0.mts   （全过打印 OK n 并 exit 0；任一失败 exit 1）
//
// ❗ 不要用 mod.VERSION 判版本：Percho 打包态设了 PI_PACKAGE_DIR，SDK 的 VERSION = getPackageDir()
//    读到的 package.json 版本（= 随包分发的 pi-package），不是真正 resolve 到的 SDK。详见 spec §7.2。
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const mod = await import("@earendil-works/pi-coding-agent");

const ok: string[] = [];
const bad: string[] = [];
const info: string[] = [];
const check = (name: string, cond: boolean, extra = "") => {
	(cond ? ok : bad).push(`${name}${extra ? ` — ${extra}` : ""}`);
};

// 1. 真正 resolve 到的 SDK 版本（不用 mod.VERSION，见文件头）
// 该包 exports 只有 import 条件、没有 require → 用 import.meta.resolve（createRequire 会 ERR_PACKAGE_PATH_NOT_EXPORTED）
const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
let pkgRoot = dirname(entry);
while (!existsSync(join(pkgRoot, "package.json")) || pkgRoot === "/") pkgRoot = dirname(pkgRoot);
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { name: string; version: string };
info.push(`resolve 到 ${pkg.name}@${pkg.version}（${pkgRoot}）；mod.VERSION 报 ${mod.VERSION}`);
check("1 resolve 到的 SDK === 1.0.4", pkg.version === "1.0.4", `实际 ${pkg.version}`);

// 2. 三个内置扩展工厂可从包根 import（llama.cpp 不在其中，见 3/4）
check(
	"2 三个内置扩展工厂可 import",
	["createMcpExtension", "createToolSearchExtension", "createCodemodeExtension"].every(
		(k) => typeof (mod as Record<string, unknown>)[k] === "function",
	),
);

// 3. 负向断言：深路径被 exports map 拦；根导出没有 builtInExtensions
{
	let deepBlocked = false;
	let code = "";
	try {
		require.resolve("@earendil-works/pi-coding-agent/dist/extensions/index.js");
	} catch (e) {
		deepBlocked = true;
		code = (e as { code?: string }).code ?? "";
	}
	check("3a 深路径被 exports map 拦", deepBlocked && code === "ERR_PACKAGE_PATH_NOT_EXPORTED", code);
	// 官方若已导出 builtInExtensions，不是错误，是提示：可把 llama.cpp 一行补回（spec §4.4）
	check("3b 根导出无 builtInExtensions", !("builtInExtensions" in mod));
	if ("builtInExtensions" in mod) {
		info.push("HINT: 官方已导出 builtInExtensions，可把 llama.cpp 一行补回（spec §4.4）");
	}
}

// 4. 仅作事实记录：文件在、但拿不到 factory（本批不接 llama.cpp 的依据）
check("4 dist/extensions/llama/index.js 文件存在", existsSync(join(pkgRoot, "dist/extensions/llama/index.js")));

// 5. quickjs-wasi：codemode 沙箱的 wasm（阶段 6 打包风险的 dev 态前置信号）
{
	let wasm = "";
	for (const resolveOne of [() => require.resolve("quickjs-wasi/quickjs.wasm"), () => fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"))]) {
		try {
			wasm = resolveOne();
			break;
		} catch {
			wasm = "";
		}
	}
	const size = wasm ? readFileSync(wasm).length : 0;
	check("5 quickjs.wasm 可解析且非空", size > 0, wasm ? `${(size / 1048576).toFixed(1)}MB` : "resolve 失败");
}

// 6. SessionManager 查询能力（findById 精确查表 + list/listAll 的增量回调与取消信号）
{
	type SM = {
		findById?: unknown;
		list?: unknown;
		listAll?: unknown;
	};
	const SM = mod.SessionManager as unknown as SM;
	check("6a SessionManager.findById 存在", typeof SM.findById === "function");
	// 回调参数是类型层的事实，运行时拿不到 → 从 .d.ts 原文核（plan 阶段 0 断言 6 的「稳妥写法」）
	const dts = readFileSync(join(pkgRoot, "dist/core/session-manager.d.ts"), "utf8");
	check(
		"6b list/listAll 带 onProgress + signal",
		/static list\([^)]*onProgress\?[^)]*signal\?: AbortSignal/.test(dts) &&
			/static listAll\([^)]*signal\?: AbortSignal/.test(dts),
	);
	check("6c SessionListProgress 带第 3 参 partialSessions", /SessionListProgress\s*=[\s\S]{0,200}partialSessions/.test(dts));
}

// 7. 上下文刷新与 context_edit 写入 API（阶段 1 撤回修复 / 附录 C 的官方原语）
check(
	"7 refreshContext / appendContextEdit 存在",
	typeof mod.AgentSession.prototype.refreshContext === "function" &&
		typeof mod.SessionManager.prototype.appendContextEdit === "function",
);

// 8. provider 目录：azure 改名（旧 id 静默迁移的依据）
{
	const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
	const ids = builtinProviders().map((p) => p.id);
	check("8a provider 含 azure", ids.includes("azure"));
	check("8b provider 已无 azure-openai-responses", !ids.includes("azure-openai-responses"));
	info.push(`builtinProviders 共 ${ids.length} 个`);
}

// 9. 工具函数分组：SDK 根导出 vs pi-ai 导出（别把 import 写到错的包）
{
	check(
		"9a SDK 根导出 truncateHead/truncateTail/defineTool/isToolCallEventType",
		["truncateHead", "truncateTail", "defineTool", "isToolCallEventType"].every(
			(k) => typeof (mod as Record<string, unknown>)[k] === "function",
		),
	);
	const ai = await import("@earendil-works/pi-ai");
	check("9b pi-ai 导出 getSupportedThinkingLevels", typeof ai.getSupportedThinkingLevels === "function");
}

console.log(`=== OK ${ok.length} ===`);
for (const l of ok) console.log(`  ${l}`);
if (bad.length) {
	console.log(`=== 失败 ${bad.length} ===`);
	for (const l of bad) console.log(`  ${l}`);
}
if (info.length) {
	console.log("=== 附注 ===");
	for (const l of info) console.log(`  ${l}`);
}
process.exit(bad.length ? 1 : 0);
