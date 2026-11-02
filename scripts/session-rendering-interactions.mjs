/** CDP interactions after a settled synthetic history. No clipboard or tool execution. */
import assert from "node:assert/strict";
import { measureLiveSelection } from "./session-rendering-live-selection.mjs";
import { readResources } from "./session-rendering-resources.mjs";
import { measureSweep } from "./session-rendering-sweep-probe.mjs";
import { verifyDiffViewState } from "./session-rendering-view-state.mjs";

export async function measureInteractions(renderer, snapshot, round, options = {}) {
	const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(false)");
	await pause(400);
	const point = await renderer.eval(
		`(()=>{const e=document.querySelector('.chat-scrollbar'),r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:e.scrollTop,max:e.scrollHeight-e.clientHeight}})()`,
	);
	assert(point.max > 0, "Long history must scroll");
	await renderer.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
	await renderer.send("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: point.x,
		y: point.y,
		deltaX: 0,
		deltaY: 100000,
	});
	await pause(400);
	point.top = await renderer.eval("document.querySelector('.chat-scrollbar').scrollTop");
	assert(point.top > 0, "Real wheel must reach a scrollable bottom before measuring upward movement");
	const anchor = await renderer.eval(
		`(()=>{const e=document.querySelector('.chat-scrollbar'),r=e.getBoundingClientRect();for(const row of e.querySelectorAll('[data-chat-row-key]')){const box=row.firstElementChild?.getBoundingClientRect();if(box&&box.height>0&&box.bottom>r.top&&box.top<r.bottom)return {key:row.dataset.chatRowKey,top:box.top};}return null})()`,
	);
	assert(anchor, "Scrollable history must expose a source anchor");
	await renderer.send("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: point.x,
		y: point.y,
		deltaX: 0,
		deltaY: -500,
	});
	await pause(500);
	const up = await renderer.eval("document.querySelector('.chat-scrollbar').scrollTop");
	const anchorAfter = await renderer.eval(
		`document.querySelector('[data-chat-row-key="'+CSS.escape(${JSON.stringify(anchor.key)})+'"]')?.firstElementChild?.getBoundingClientRect().top`,
	);
	// Prepending older rows increases scrollTop while preserving source positions.
	assert(
		anchorAfter > anchor.top + 1,
		`Real wheel must move the same source downward in the viewport (scrollTop ${point.top} -> ${up})`,
	);
	await snapshot("history-wheel-up", round);
	await renderer.send("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: point.x,
		y: point.y,
		deltaX: 0,
		deltaY: 100000,
	});
	await pause(500);
	await snapshot("history-wheel-bottom", round);
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(true)");
	await pause(400);
	await snapshot("history-diff-open", round);
	await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(false)");
	await pause(400);
	await snapshot("history-diff-close", round);
	// Existing paging must be traversed before claiming a 500-tool group was exercised.
	const until = Date.now() + 30000;
	for (;;) {
		const found = await renderer.eval(
			`(()=>{const groups=[...document.querySelectorAll("details[class*='group/outer']")];const group=groups.find(g=>g.querySelector('summary').querySelectorAll('[class~="h-1"][class~="w-1"]').length>=500);if(!group)return false;__renderDiag.bigGroup=group;group.scrollIntoView({block:'center'});return true})()`,
		);
		if (found) break;
		assert(Date.now() < until, "Real wheel paging did not expose the 500-tool source group");
		await renderer.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: point.x,
			y: point.y,
			deltaX: 0,
			deltaY: -100000,
		});
		await pause(200);
	}
	await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
	await snapshot("history-paged-large-group", round);
	const resourcesBefore = options.resources ? await readResources(renderer) : null;
	const group = await renderer.eval(
		"__renderDiag.bigGroup.querySelector('summary').getBoundingClientRect().toJSON()",
	);
	assert(
		group && group.y >= 0 && group.y < point.y * 2,
		"Large group summary must be visible for a real click",
	);
	{
		const start = performance.now();
		await renderer.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: group.x + 20,
			y: group.y + 10,
			button: "left",
			clickCount: 1,
		});
		await renderer.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: group.x + 20,
			y: group.y + 10,
			button: "left",
			clickCount: 1,
		});
		await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
		const elapsed = performance.now() - start;
		const sample = await snapshot("history-group-expand", round);
		sample.expandRoundTripMs = elapsed;
		sample.expandedTools = await renderer.eval(
			"__renderDiag.bigGroup.querySelectorAll(\"details[class*='group/dets']\").length",
		);
		assert(sample.expandedTools >= 500, "Click did not expand the complete source group");
		if (options.resources) sample.resources = await readResources(renderer);
	}
	await pause(400);
	await renderer.eval(
		"__renderDiag.focusEditor=document.querySelector('[contenteditable=true]');__renderDiag.focusEditor.focus()",
	);
	for (const [stage, change] of [
		["sidebar-close-clean", "__renderDiag.prefs.setState({sidebarCollapsed:true})"],
		["sidebar-open-clean", "__renderDiag.prefs.setState({sidebarCollapsed:false})"],
		["diff-open-clean", "__renderDiag.ui.getState().setDiffSidebarOpen(true)"],
		["diff-close-clean", "__renderDiag.ui.getState().setDiffSidebarOpen(false)"],
	]) {
		await renderer.eval(
			`__renderDiag.frames=[];__renderDiag.longTasks=[];__renderDiag.last=0;${change};true`,
		);
		await pause(500);
		const animation = await renderer.eval(
			"(()=>{const d=__renderDiag;const result={frames:d.frames.splice(0),longTasks:d.longTasks.splice(0)};d.last=0;return result})()",
		);
		const sample = await snapshot(stage, round);
		Object.assign(sample, animation);
		sample.frameMetric = "rAF window ends before DOM/memory probes";
		assert(
			await renderer.eval("document.activeElement===__renderDiag.focusEditor"),
			"Programmatic sidebar animation must preserve editor focus",
		);
	}
	await renderer.eval("delete __renderDiag.focusEditor");
	await measureSweep(renderer, options.main, options.channel, snapshot, round);
	if (options.after) {
		const folded = await measureLiveSelection(renderer, snapshot, round, options);
		if (options.resources) {
			folded.resources = await readResources(renderer);
			folded.resourcesBefore = resourcesBefore;
			assert(
				folded.resources.ResizeObserver.targets <= resourcesBefore.ResizeObserver.targets,
				"Folded tool rows must release observations",
			);
		}
	}
	await renderer.eval("delete __renderDiag.bigGroup");
	if (options.resources) await verifyDiffViewState(renderer, snapshot, round);
}
