/** Count real sweep-target layout reads in a stationary and moving production preview. */
import assert from "node:assert/strict";
export async function measureSweep(renderer, main, channel, snapshot, round) {
	const pause = (ms) => new Promise((r) => setTimeout(r, ms)),
		sid = await renderer.eval("__renderDiag.sid");
	// The preceding large-group interaction deliberately browses old history.
	// Return via real wheel before requiring the new activity row to be mounted.
	const bottom = await renderer.eval(
		"(()=>{const e=document.querySelector('.chat-scrollbar'),r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()",
	);
	await renderer.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...bottom });
	await renderer.send("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		...bottom,
		deltaX: 0,
		deltaY: 100000,
	});
	const until = Date.now() + 10000;
	while (
		!(await renderer.eval(
			"(()=>{const e=document.querySelector('.chat-scrollbar');return Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop)<=2})()",
		))
	) {
		assert(Date.now() < until, "Real wheel must reach the bottom before measuring active sweep targets");
		await pause(20);
	}
	const events = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		...[
			{ type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", name: "bash" }] } },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"echo geometry"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "geometry-probe", name: "bash", arguments: { command: "echo geometry" } },
			},
		].map((assistantMessageEvent) => ({ type: "message_update", assistantMessageEvent })),
		{
			type: "tool_execution_start",
			toolCallId: "geometry-probe",
			toolName: "bash",
			args: { command: "echo geometry" },
		},
	];
	const send = (events) =>
		main.eval(
			`(()=>{const win=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0];for(const event of ${JSON.stringify(events)})win.webContents.send(${JSON.stringify(channel)},{sessionId:${JSON.stringify(sid)},event});return true})()`,
		);
	await send(events);
	await pause(500);
	await renderer.eval(
		"__renderDiag.geomOriginal=HTMLElement.prototype.getBoundingClientRect;__renderDiag.geomCount=0;__renderDiag.geomRecording=true;HTMLElement.prototype.getBoundingClientRect=function(){if(__renderDiag.geomRecording&&this.matches('.sweep-target,[data-shimmer-name]'))__renderDiag.geomCount++;return __renderDiag.geomOriginal.call(this)}",
	);
	try {
		await pause(1500);
		const stationary = await renderer.eval("__renderDiag.geomRecording=false;__renderDiag.geomCount");
		const sample = await snapshot("sweep-stationary", round);
		sample.targetRectReads = stationary;
		sample.probeDurationMs = 1500;
		for (const collapsed of [true, false]) {
			await renderer.eval(
				`__renderDiag.geomCount=0;__renderDiag.geomRecording=true;__renderDiag.prefs.setState({sidebarCollapsed:${collapsed}});true`,
			);
			await pause(100);
			const alignment = await renderer.eval(
				`new Promise(resolve=>requestAnimationFrame(()=>{const d=__renderDiag;d.geomRecording=false;const centers=[...document.querySelectorAll('.sweep-target,[data-shimmer-name]')].flatMap(el=>{const rect=el.getBoundingClientRect(),match=el.style.backgroundImage.match(/(-?[\\d.]+)px/);return rect.width>0&&match?[rect.left+Number(match[1])]:[]});d.geomRecording=true;resolve({count:centers.length,spread:centers.length?Math.max(...centers)-Math.min(...centers):null})}))`,
			);
			assert(
				alignment.count >= 2 && alignment.spread < 1,
				"Moving label and tool must share an aligned sweep phase",
			);
			await pause(400);
			const reads = await renderer.eval("__renderDiag.geomRecording=false;__renderDiag.geomCount");
			const sample = await snapshot(collapsed ? "sweep-sidebar-close" : "sweep-sidebar-open", round);
			sample.targetRectReads = reads;
			sample.alignment = alignment;
		}
	} finally {
		await renderer.eval(
			"HTMLElement.prototype.getBoundingClientRect=__renderDiag.geomOriginal;delete __renderDiag.geomOriginal;delete __renderDiag.geomRecording",
		);
		await send([
			{
				type: "tool_execution_end",
				toolCallId: "geometry-probe",
				toolName: "bash",
				isError: false,
				result: { content: [{ type: "text", text: "synthetic" }] },
			},
			{ type: "agent_end", messages: [], willRetry: false },
		]);
		await pause(400);
	}
}
