/** Local renderer view-state regression after the real IPC/paging scenarios. No model calls. */
import assert from "node:assert/strict";
import { verifyLateImage } from "./session-rendering-image-regression.mjs";
export async function verifyDiffViewState(renderer, snapshot, round) {
	const pause = (ms) => new Promise((r) => setTimeout(r, ms));
	const target = await renderer.eval(
		`(()=>{const d=__renderDiag,s=d.transcripts.getState().bySession[d.sid];let user;const seen=new Map();for(const m of s.messages){if(m.kind==='user'){user=m.id;continue;}if(m.kind!=='assistant')continue;for(const tool of m.tools){if(tool.name!=='write')continue;const args=JSON.parse(tool.args),key=user+':'+args.path;const previous=seen.get(key);if(previous)return tool.key;seen.set(key,tool.key);}}return null})()`,
	);
	assert(target, "Fixture must have a later section of the same source file");
	await renderer.eval(
		`(()=>{const d=__renderDiag;d.core.views.getState().setScope(d.sid,'latest');d.ui.getState().setDiffFocus(${JSON.stringify(target)},d.sid);d.ui.getState().setDiffSidebarOpen(true)})()`,
	);
	const end = Date.now() + 5000;
	while (await renderer.eval("!!__renderDiag.ui.getState().diffFocus")) {
		assert(Date.now() < end, "Source focus did not settle");
		await pause(50);
	}
	let previous = -1;
	for (;;) {
		const current = await renderer.eval("document.querySelector('[data-diff-scroll-root]').scrollTop");
		if (Math.abs(current - previous) < 1) break;
		assert(Date.now() < end, "Smooth focus did not settle");
		previous = current;
		await pause(150);
	}
	assert(
		await renderer.eval(
			`(()=>{const e=document.querySelector('[data-section-key="'+CSS.escape(${JSON.stringify(target)})+'"]'),root=document.querySelector('[data-diff-scroll-root]');if(!e||!root)return false;const a=e.getBoundingClientRect(),b=root.getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom&&__renderDiag.core.views.getState().bySession[__renderDiag.sid].scope==='all'})()`,
		),
		"Later source section must become visible outside latest scope",
	);
	const anchor = await renderer.eval("__renderDiag.core.views.getState().bySession[__renderDiag.sid].anchor");
	assert(anchor, "Focused view must capture a source anchor");
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(false)");
	await pause(500);
	assert.equal(
		await renderer.eval("document.querySelector('.diff-sidebar-in')"),
		null,
		"Closed sidebar must release its view",
	);
	const added = [
		{ kind: "user", id: "view-new-user", text: "synthetic", images: [], timestamp: 1 },
		{
			kind: "assistant",
			id: "view-new-assistant",
			text: "",
			thinking: "",
			timestamp: 2,
			tools: [
				{
					key: "view-new-tool",
					id: "view-new-tool",
					name: "write",
					args: JSON.stringify({
						path: "view-state-new.ts",
						content: Array.from({ length: 150 }, (_, i) => `synthetic line ${i}`).join("\n"),
					}),
					output: "synthetic",
					state: "done",
				},
			],
		},
	];
	await renderer.eval(
		`(()=>{const d=__renderDiag;d.transcripts.setState(state=>{const s=state.bySession[d.sid];return{bySession:{...state.bySession,[d.sid]:{...s,messages:[...s.messages,...${JSON.stringify(added)}]}}}})})()`,
	);
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(true)");
	await pause(500);
	const restored = await renderer.eval(
		`(()=>{const root=document.querySelector('[data-diff-scroll-root]'),card=root.querySelector('[data-view-key="'+CSS.escape(${JSON.stringify(anchor.key)})+'"]');return card.getBoundingClientRect().top-root.getBoundingClientRect().top})()`,
	);
	assert(
		Math.abs(restored - anchor.offset) < 2,
		`Background additions must preserve the old source offset (saved=${anchor.offset},actual=${restored})`,
	);
	const wheelTarget = await renderer.eval(
		"(()=>{const r=document.querySelector('[data-diff-scroll-root]').getBoundingClientRect(),b=document.querySelector('[data-section-key=\"view-new-tool\"] .diff-more').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,deltaY:b.top-r.top-r.height/2}})()",
	);
	await renderer.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheelTarget, deltaX: 0 });
	await pause(200);
	const rect = await renderer.eval(
		"document.querySelector('[data-section-key=\"view-new-tool\"] .diff-more').getBoundingClientRect().toJSON()",
	);
	assert(
		await renderer.eval(`!!document.elementFromPoint(${rect.x + 10},${rect.y + 10})?.closest('.diff-more')`),
		"Expand-all must be the real hit target",
	);
	for (const type of ["mousePressed", "mouseReleased"])
		await renderer.send("Input.dispatchMouseEvent", {
			type,
			x: rect.x + 10,
			y: rect.y + 10,
			button: "left",
			clickCount: 1,
		});
	await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
	assert.equal(
		await renderer.eval(
			"document.querySelectorAll('[data-section-key=\"view-new-tool\"] .diff-line').length",
		),
		150,
	);
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(false)");
	await pause(500);
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(true)");
	await pause(500);
	assert.equal(
		await renderer.eval(
			"document.querySelectorAll('[data-section-key=\"view-new-tool\"] .diff-line').length",
		),
		150,
		"Reopen must preserve expand-all",
	);
	const other = await renderer.eval(
		"(async()=>{const d=__renderDiag;const cwd=d.sessions.getState().sessions.find(s=>s.sessionId===d.sid).cwd;const meta=await d.getExecutionApi({kind:'local'}).createSession({options:{cwd}});d.transcripts.getState().loadHistory(meta.sessionId,[]);d.sessions.setState(s=>({sessions:[...s.sessions,meta],activeSessionId:meta.sessionId,newSessionDraft:null}));return meta.sessionId})()",
	);
	await pause(400);
	assert.equal(
		await renderer.eval("document.querySelectorAll('.diff-line').length"),
		0,
		"Another session must not show old file details",
	);
	await renderer.eval("__renderDiag.sessions.setState({activeSessionId:__renderDiag.sid})");
	await pause(500);
	assert.equal(
		await renderer.eval(
			"document.querySelectorAll('[data-section-key=\"view-new-tool\"] .diff-line').length",
		),
		150,
		"Switching a resident session back must retain expand-all",
	);
	await renderer.eval(`__renderDiag.sessions.getState().closeSession(${JSON.stringify(other)})`);
	await renderer.eval(`__renderDiag.ui.getState().setDiffFocus(${JSON.stringify(target)},__renderDiag.sid)`);
	const point = await renderer.eval(
		"(()=>{const r=document.querySelector('[data-diff-scroll-root]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()",
	);
	await renderer.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: 60 });
	await pause(80);
	const scroll = await renderer.eval("document.querySelector('[data-diff-scroll-root]').scrollTop");
	await pause(500);
	assert.equal(
		await renderer.eval("__renderDiag.ui.getState().diffFocus"),
		null,
		"User wheel must cancel old focus",
	);
	assert(
		Math.abs((await renderer.eval("document.querySelector('[data-diff-scroll-root]').scrollTop")) - scroll) <
			2,
		"Late source focus must not undo new user scrolling",
	);
	await snapshot("view-state-restored-and-cancelled", round);
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(false)");
	await pause(500);
	await verifyLateImage(renderer, snapshot, round);
	const original = await renderer.eval(
		"({width:outerWidth,height:outerHeight,sidebar:__renderDiag.prefs.getState().sidebarWidth})",
	);
	try {
		await renderer.eval("window.resizeTo(820,900);__renderDiag.prefs.getState().previewSidebarWidth(480)");
		await pause(400);
		assert(
			await renderer.eval("document.documentElement.scrollWidth<=innerWidth"),
			"Narrow window must not overflow horizontally",
		);
		assert(
			await renderer.eval(
				"Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width-document.querySelector('.sidebar-inner').getBoundingClientRect().width)<1",
			),
			"Narrow sidebar inner and outer widths must be clamped together",
		);
		const handle = await renderer.eval(
			"document.querySelector('[data-sidebar-resize-handle]').getBoundingClientRect().toJSON()",
		);
		const x = handle.x + handle.width / 2,
			y = handle.y + handle.height / 2;
		await renderer.eval("document.querySelector('[contenteditable=true]').focus()");
		await renderer.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await renderer.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			clickCount: 1,
		});
		await renderer.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: x + 30,
			y,
			button: "left",
			buttons: 1,
		});
		assert.equal(
			await renderer.eval("document.body.style.cursor"),
			"col-resize",
			"Real drag must hit the resize handle",
		);
		await renderer.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 31, y, buttons: 0 });
		await renderer.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: x + 31,
			y,
			button: "left",
			clickCount: 1,
		});
		await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
		assert.equal(await renderer.eval("document.body.style.cursor"), "", "Lost-up recovery must end dragging");
		assert(
			await renderer.eval("!document.querySelector('.sidebar').classList.contains('is-resizing')"),
			"Drag state must not remain stuck",
		);
		await renderer.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(true)");
		await pause(50);
		await renderer.eval(
			"document.querySelector('.diff-side-close').focus();__renderDiag.ui.getState().setDiffSidebarOpen(false)",
		);
		await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
		assert(
			await renderer.eval("document.activeElement===document.querySelector('[data-diff-toggle]')"),
			"Closing a focused panel must return focus to its trigger",
		);
		assert.equal(
			await renderer.eval("document.querySelector('.diff-sidebar-in')"),
			null,
			"Reduced motion must release the closing view immediately",
		);
		await snapshot("narrow-drag-and-reduced-motion", round);
	} finally {
		await renderer.send("Emulation.setEmulatedMedia", { features: [] });
		await renderer.eval(
			`window.resizeTo(${original.width},${original.height});__renderDiag.prefs.getState().previewSidebarWidth(${original.sidebar});__renderDiag.prefs.getState().commitSidebarWidth()`,
		);
		await pause(400);
	}
}
