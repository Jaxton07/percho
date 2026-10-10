/**
 * #101 浏览器端到端：真实 ProviderRow 点击 → store → IPC → ModelPrefsService → 文件/模型菜单。
 * 在仓库根运行（仅允许 .local/ 下的隔离 agent，不使用真实密钥/生成/联网刷新）：
 *   node scripts/verify-model-visibility.mjs prepare .local/tmp/model-visibility/agent
 *   cd packages/desktop && PI_CODING_AGENT_DIR=<绝对 agent 路径> npx electron-vite dev -- --remote-debugging-port=9224 --inspect=9229 --user-data-dir=<隔离 userData>
 *   node scripts/verify-model-visibility.mjs before <agent 路径>
 *   退出并按原参数重启 dev（重启后后端 cache 消失）：
 *   node scripts/verify-model-visibility.mjs after <同一 agent 路径>
 * before 留存增长后的模型目录与偏好供重启验收；after 验全显清名单。
 * IPC 延时/一次失败注入在 finally 恢复，当前会话不发消息，目录仅写隔离夹具。
 * Windows 原始侧栏问题仍须实机手测，此脚本不能替代。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const mode = process.argv[2];
const root = resolve(".");
const agent = resolve(process.argv[3] ?? ".local/tmp/model-visibility/agent");
assert.ok(agent.startsWith(join(root, ".local") + sep), "仅允许仓库 .local/ 下的隔离 agent");
const P = "fixture-visibility",
	L = "fixture-legacy",
	Z = "fixture-empty";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configPath = join(agent, "models.json"),
	prefsPath = join(agent, "model-prefs.json");
const model = (id, name) => ({ id, name, contextWindow: 8192, maxTokens: 1024 });
if (mode === "prepare") {
	await mkdir(agent, { recursive: true });
	const provider = (models) => ({
		baseUrl: "https://example.invalid/v1",
		api: "openai-completions",
		apiKey: "fixture-only-not-a-real-key",
		models,
	});
	await writeFile(
		configPath,
		JSON.stringify(
			{
				providers: {
					[P]: provider([model("a", "Fixture A"), model("b", "Fixture B")]),
					[L]: provider([model("x", "Legacy X"), model("y", "Legacy Y")]),
					[Z]: provider([]),
				},
			},
			null,
			2,
		),
		{ flag: "wx" },
	);
	await writeFile(
		prefsPath,
		JSON.stringify({ hiddenModels: { [L]: ["x", "y"] }, subagentModels: {} }, null, 2),
		{ flag: "wx" },
	);
	console.log(`夹具已准备：${agent}`);
	process.exit(0);
}
assert.ok(["before", "after"].includes(mode), "用法：prepare|before|after [隔离 agent 路径]");

async function connect(port, pick) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const target = targets.find(pick);
	assert.ok(target, `调试端口 ${port} 无目标`);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((yes, no) => {
		ws.onopen = yes;
		ws.onerror = no;
	});
	let id = 0;
	const pending = new Map();
	ws.onmessage = ({ data }) => {
		const m = JSON.parse(data),
			p = pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		clearTimeout(p.timer);
		m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
	};
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const n = ++id;
			const timer = setTimeout(() => {
				pending.delete(n);
				reject(Error(`${method} 超时`));
			}, 15000);
			pending.set(n, { resolve, reject, timer });
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	return {
		send,
		close: () => ws.close(),
		eval: async (expression) => {
			const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (result.exceptionDetails)
				throw Error(result.exceptionDetails.exception?.description ?? "页面执行失败");
			return result.result.value;
		},
	};
}
const page = await connect(9224, (t) => t.type === "page");
const main = await connect(9229, (t) => !!t.webSocketDebuggerUrl);
let checks = 0,
	initialModel,
	environment;
const check = (name, fn) => {
	fn();
	console.log(`PASS ${name}`);
	checks++;
};
const row = (provider) =>
	`[...document.querySelectorAll('li')].find(li => [...li.querySelectorAll('span.font-medium')].some(s => s.textContent === ${JSON.stringify(provider)}))`;
async function click(expression) {
	await page.eval(
		`(() => {const el = ${expression}; if (!el) throw Error('点击目标不存在'); el.scrollIntoView({block:'center'});})()`,
	);
	await wait(async () => {
		const hittable = await page.eval(
			`(() => {const el=${expression};if(!el)return false;const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()`,
		);
		assert.ok(hittable, "点击目标尚被过渡/蒙层遮挡");
	});
	const r = await page.eval(
		`(() => {const el=${expression}, r=el.getBoundingClientRect(); if(r.width===0||r.height===0)throw Error('点击目标不可见');return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
	);
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + 2, y: r.y });
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...r });
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		...r,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		...r,
		button: "left",
		buttons: 0,
		clickCount: 1,
	});
	await sleep(35);
}
const sourceClick = (p) => click(`(${row(p)}).querySelector('button[role="switch"]')`);
async function modelClick(name) {
	const expanded = await page.eval(
		`(${row(P)}).querySelector('button[aria-expanded]').getAttribute('aria-expanded')`,
	);
	if (expanded !== "true") await click(`(${row(P)}).querySelector('button[aria-expanded]')`);
	await click(`(${row(P)}).querySelector('button[role="switch"][aria-label=${JSON.stringify(name)}]')`);
}
async function openSettings() {
	await page.eval(`window.__visibilityTest.settings.getState().openWith('models')`);
	await wait(async () =>
		assert.equal(await page.eval(`window.__visibilityTest.settings.getState().loading`), false),
	);
}
async function wait(fn) {
	const until = Date.now() + 12000;
	let last;
	do {
		try {
			await fn();
			return;
		} catch (e) {
			last = e;
			await sleep(60);
		}
	} while (Date.now() < until);
	throw last;
}
let backendObjectId;
async function closureBinding(objectId, name) {
	const details = await main.send("Runtime.getProperties", { objectId });
	const scopesId = details.internalProperties.find((p) => p.name === "[[Scopes]]")?.value.objectId;
	assert.ok(scopesId, "IPC 回调 scope 不可检查");
	const scopes = await main.send("Runtime.getProperties", { objectId: scopesId, ownProperties: true });
	for (const scope of scopes.result) {
		if (!scope.value?.objectId) continue;
		const bindings = await main.send("Runtime.getProperties", {
			objectId: scope.value.objectId,
			ownProperties: true,
		});
		const binding = bindings.result.find((p) => p.name === name)?.value;
		if (binding?.objectId) return binding.objectId;
	}
	throw Error(`IPC closure 缺少 ${name}`);
}
async function backendModel(sessionId) {
	if (!backendObjectId) {
		const fn = await main.send("Runtime.evaluate", {
			expression:
				"process.mainModule.require('electron').ipcMain._invokeHandlers.get('settings:getModelPrefs')",
		});
		const handler = await closureBinding(fn.result.objectId, "handler");
		backendObjectId = await closureBinding(handler, "backend");
	}
	// SDK 1.0.4 的零消息会话还没落盘，listSessions 是磁盘目录，不能用它检查活体模型。
	const result = await main.send("Runtime.callFunctionOn", {
		objectId: backendObjectId,
		functionDeclaration: "function(id){return this.toMetaOrThrow(id).model}",
		arguments: [{ value: sessionId }],
		returnByValue: true,
	});
	if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description);
	return result.result.value;
}
async function snapshot() {
	const result =
		await page.eval(`(() => {const {settings,sessions}=window.__visibilityTest, s=sessions.getState(); return {
		activeSessionId:s.activeSessionId,
		prefs:settings.getState().modelPrefs,error:settings.getState().error,
		ids:s.models.filter(m=>m.provider===${JSON.stringify(P)}).map(m=>m.id).sort(),
		legacy:s.models.filter(m=>m.provider===${JSON.stringify(L)}).map(m=>m.id).sort(),
		current:s.sessions.find(m=>m.sessionId===s.activeSessionId)?.model ?? s.newSessionDraft?.model,
		configured:settings.getState().providers.filter(p=>p.id.startsWith('fixture-')).map(p=>({id:p.id,configured:p.configured})),
		source:(${row(P)})?.querySelector('button[role="switch"]')?.getAttribute('aria-checked')
	};})()`);
	if (mode === "before" && result.activeSessionId)
		result.backendCurrent = await backendModel(result.activeSessionId);
	return result;
}
async function agree(name, ids, predicate, source) {
	await wait(async () => {
		const s = await snapshot(),
			disk = JSON.parse(await readFile(prefsPath, "utf8"));
		assert.deepEqual(s.prefs, disk);
		assert.equal(s.configured.length, 3);
		assert.ok(
			s.configured.every((p) => p.configured),
			"隐藏不能停用源或移除凭证",
		);
		assert.deepEqual(s.ids, ids);
		predicate(disk);
		assert.deepEqual(s.current, initialModel, "当前会话模型不能自动切换");
		if (mode === "before") assert.deepEqual(s.backendCurrent, initialModel, "真实后端会话模型不能自动切换");
		if (source !== undefined) assert.equal(s.source, source);
	});
	console.log(`PASS ${name}（文件/开关/选择器数据/当前模型一致）`);
	checks++;
}
async function menu(ids) {
	await page.eval(`window.__visibilityTest.settings.getState().setOpen(false)`);
	await sleep(80);
	const chip = `[...document.querySelectorAll('button')].find(b=>b.querySelector('span.truncate')&&[...b.querySelectorAll('span')].some(s=>s.textContent==='·'))`;
	await click(chip);
	await wait(async () => {
		assert.ok(await page.eval(`!!document.querySelector('[data-composer-overlay]')`), "模型菜单未打开");
		const actual = await page.eval(
			`([...document.querySelectorAll('[data-model-key]')].map(e=>e.dataset.modelKey).filter(k=>k.startsWith('${P}/')).map(k=>k.split('/')[1])).sort()`,
		);
		assert.deepEqual(actual, ids);
	});
	console.log(`PASS 真实模型菜单 ${JSON.stringify(ids)}`);
	checks++;
	await click(chip);
	await openSettings();
}
async function refreshCatalog() {
	await page.eval(
		`(async()=>{await window.__visibilityTest.settings.getState().refresh();await window.__visibilityTest.sessions.getState().loadModels();})()`,
	);
}
try {
	const env = await main.eval(
		`({pid:process.pid,agent:process.env.PI_CODING_AGENT_DIR,userData:process.mainModule.require('electron').app.getPath('userData')})`,
	);
	environment = env;
	assert.equal(env.agent, agent, "连接的不是指定隔离 agent");
	assert.ok(env.userData.startsWith(join(root, ".local") + sep), "连接的不是隔离 userData");
	await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await page.eval(
		`(async()=>{const {useSettingsStore:settings}=await import('/src/stores/settings.ts');const {useSessionsStore:sessions}=await import('/src/stores/sessions.ts');window.__visibilityTest={settings,sessions};})()`,
	);
	await refreshCatalog();
	// before 建真实空白会话验证后端模型不被切换；拒绝 fixture cwd 的项目信任，不加载项目资源。
	if (
		mode === "before" &&
		!(await page.eval(`window.__visibilityTest.sessions.getState().activeSessionId`))
	) {
		const cwd = join(resolve(agent, ".."), "cwd");
		await mkdir(cwd, { recursive: true });
		await page.eval(`(async()=>{const s=window.__visibilityTest.sessions.getState();s.activateNewSessionDraftForCwd(${JSON.stringify(cwd)});await s.setCurrentModel('${P}','a');
			window.__visibilityTest.promotion='pending';void s.createSession().then(id=>{window.__visibilityTest.promotion=id;},e=>{window.__visibilityTest.promotion='error:'+e.message;});})()`);
		await wait(async () => {
			const rejectTrust = `[...document.querySelectorAll('button')].find(b=>['不信任','Don’t trust',"Don't trust"].includes(b.textContent.trim()))`;
			if (await page.eval(`!!(${rejectTrust})`)) await click(rejectTrust);
			assert.ok(await page.eval(`!!window.__visibilityTest.sessions.getState().activeSessionId`));
		});
	}
	// after 只设置 draft 测试起点，不发送消息/调用生成。
	await page.eval(
		`(async()=>{const s=window.__visibilityTest.sessions.getState();if(!s.activeSessionId)await s.setCurrentModel('${P}','a');})()`,
	);
	initialModel = (await snapshot()).current;
	assert.deepEqual(initialModel, { provider: P, modelId: "a" });
	await openSettings();
	if (mode === "before") {
		await agree(
			"旧名单不推测源默认",
			["a", "b"],
			(p) => {
				assert.deepEqual(p.hiddenModels[L], ["x", "y"]);
				assert.equal(p.hiddenProviders, undefined);
			},
			"true",
		);
		const initialLegacy = (await snapshot()).legacy;
		check("旧名单源当前无可选模型", () => assert.deepEqual(initialLegacy, []));
		await sourceClick(P);
		await agree("真实整源点击全藏", [], (p) => assert.ok(p.hiddenProviders.includes(P)), "false");
		await menu([]);
		await modelClick("Fixture A");
		await agree("真实单项点击建立白名单", ["a"], (p) => assert.deepEqual(p.visibleModels[P], ["a"]), "mixed");
		await menu(["a"]);
		const config = JSON.parse(await readFile(configPath, "utf8"));
		config.providers[P].models.push(model("c", "Fixture C"));
		config.providers[L].models.push(model("z", "Legacy Z"));
		await writeFile(configPath, JSON.stringify(config, null, 2));
		await refreshCatalog();
		await agree("目录增长不放出新模型", ["a"], (p) => assert.deepEqual(p.visibleModels[P], ["a"]), "mixed");
		await menu(["a"]);
		const grownLegacy = (await snapshot()).legacy;
		check("旧具体名单目录增长仍可见新增 ID", () => assert.deepEqual(grownLegacy, ["z"]));
		// legacy 的混合态点击全藏后全显，清掉旧名单。
		await sourceClick(L);
		await wait(async () =>
			assert.ok(JSON.parse(await readFile(prefsPath, "utf8")).hiddenProviders.includes(L)),
		);
		await sourceClick(L);
		await wait(async () =>
			assert.equal(JSON.parse(await readFile(prefsPath, "utf8")).hiddenModels[L], undefined),
		);
		await sourceClick(Z);
		await wait(async () =>
			assert.ok(JSON.parse(await readFile(prefsPath, "utf8")).hiddenProviders.includes(Z)),
		);
		const zeroHidden = JSON.parse(await readFile(prefsPath, "utf8"));
		check("零目录真实开关可持久化隐藏默认", () => assert.ok(zeroHidden.hiddenProviders.includes(Z)));
		// 捕获实际 Electron IPC；只延时/一次失败，成功分支仍走原 handler/service/file。
		await main.eval(`(() => {const ipc=process.mainModule.require('electron').ipcMain; const originals=new Map();
			globalThis.__visibilityProbe={originals,failOnce:false,calls:[]};
			for(const channel of ['settings:setProviderModelsHidden','settings:setModelHidden']) {
				const original=ipc._invokeHandlers.get(channel); originals.set(channel,original);
				ipc._invokeHandlers.set(channel,async(...args)=>{const p=globalThis.__visibilityProbe; p.calls.push({channel,args:args[1]});
					await new Promise(r=>setTimeout(r,350)); if(p.failOnce){p.failOnce=false;throw Error('fixture write failure');}return original(...args);});
			} return true;})()`);
		await sourceClick(P);
		await modelClick("Fixture A");
		await sourceClick(P);
		await modelClick("Fixture B");
		await agree(
			"实 UI 快速四次操作最终只显示 B",
			["b"],
			(p) => assert.deepEqual(p.visibleModels[P], ["b"]),
			"mixed",
		);
		await menu(["b"]);
		// 基线改为只选 A，模拟整源全藏失败；后继选 B 不能被回滚覆盖。
		await sourceClick(P);
		await modelClick("Fixture A");
		await agree("失败测试基线只选 A", ["a"], (p) => assert.deepEqual(p.visibleModels[P], ["a"]), "mixed");
		await main.eval(`globalThis.__visibilityProbe.failOnce=true`);
		await sourceClick(P);
		await modelClick("Fixture B");
		await agree(
			"一次失败重读仍保留后继 B，与原 A 合并",
			["a", "b"],
			(p) => assert.deepEqual(p.visibleModels[P], ["a", "b"]),
			"mixed",
		);
		assert.match((await snapshot()).error, /fixture write failure/);
		await menu(["a", "b"]);
		const calls = await main.eval(`globalThis.__visibilityProbe.calls`);
		check("整源 IPC 无 modelIds 参数", () =>
			assert.ok(
				calls
					.filter((c) => c.channel === "settings:setProviderModelsHidden")
					.every((c) => !("modelIds" in c.args)),
			),
		);
		await writeFile(
			join(agent, "browser-evidence-before.json"),
			JSON.stringify({ checks, environment, snapshot: await snapshot(), calls }, null, 2),
		);
		console.log("重启 checkpoint：默认隐藏 P/零目录，P 仅白名单 A/B，C 不可见。");
	} else {
		const before = JSON.parse(await readFile(join(agent, "browser-evidence-before.json"), "utf8"));
		check("真实主进程 PID 已变化（不是 HMR/cache 复用）", () =>
			assert.notEqual(before.environment.pid, environment.pid),
		);
		await agree(
			"实际主进程重启后默认策略和白名单保留",
			["a", "b"],
			(p) => {
				assert.ok(p.hiddenProviders.includes(P));
				assert.ok(p.hiddenProviders.includes(Z));
				assert.deepEqual(p.visibleModels[P], ["a", "b"]);
			},
			"mixed",
		);
		await menu(["a", "b"]);
		await sourceClick(P); // mixed → 全藏
		await agree("重启后混合态点击全藏", [], (p) => assert.equal(p.visibleModels?.[P], undefined), "false");
		await sourceClick(P); // hidden → 全显
		await agree(
			"真实全显清掉 P 的默认策略及两种名单",
			["a", "b", "c"],
			(p) => {
				assert.ok(!p.hiddenProviders?.includes(P));
				assert.equal(p.visibleModels?.[P], undefined);
				assert.equal(p.hiddenModels[P], undefined);
			},
			"true",
		);
		await menu(["a", "b", "c"]);
		await sourceClick(Z);
		await wait(async () =>
			assert.ok(!JSON.parse(await readFile(prefsPath, "utf8")).hiddenProviders?.includes(Z)),
		);
		const zeroShown = JSON.parse(await readFile(prefsPath, "utf8"));
		check("零目录真实全显清默认策略", () => assert.ok(!zeroShown.hiddenProviders?.includes(Z)));
		const s = await snapshot();
		check("全部可选字段清空时文件不留空键", () => {
			assert.equal(s.prefs.hiddenProviders, undefined);
			assert.equal(s.prefs.visibleModels, undefined);
		});
		await writeFile(
			join(agent, "browser-evidence-after.json"),
			JSON.stringify({ checks, environment, snapshot: s }, null, 2),
		);
	}
	const unchangedConfig = JSON.parse(await readFile(configPath, "utf8"));
	check("只修改模型目录，三个 fixture 凭证字段原样保留", () =>
		assert.ok([P, L, Z].every((p) => unchangedConfig.providers[p].apiKey === "fixture-only-not-a-real-key")),
	);
	if (mode === "before") {
		const id = (await snapshot()).activeSessionId;
		const messages = await page.eval(`window.pi.getSessionMessages({sessionId:${JSON.stringify(id)}})`);
		check("真实空白会话无消息/无生成", () => assert.deepEqual(messages, []));
	}
	const evidencePath = join(agent, `browser-evidence-${mode}.json`);
	const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
	await writeFile(evidencePath, JSON.stringify({ ...evidence, checks }, null, 2));
	console.log(`合计 ${checks} 项 PASS（${mode}）；Windows pending`);
} finally {
	try {
		await main.eval(
			`(() => {const p=globalThis.__visibilityProbe;if(!p)return;const ipc=process.mainModule.require('electron').ipcMain;for(const [name,handler]of p.originals)ipc._invokeHandlers.set(name,handler);delete globalThis.__visibilityProbe;})()`,
		);
		assert.equal(await main.eval(`!!globalThis.__visibilityProbe`), false, "IPC 注入未清理");
		await page.eval(`delete window.__visibilityTest`);
	} finally {
		page.close();
		main.close();
	}
}
