/** Check persistent status-particle phases and bounded geometry through sidebar layout changes. */
import assert from "node:assert/strict";
export async function measureStatusParticles(renderer, main, channel, snapshot, round) {
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
		assert(Date.now() < until, "Real wheel must reach the bottom before measuring active status particles");
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
	const bounds = await main.eval(
		"process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].getBounds()",
	);
	const collapsedBefore = await renderer.eval("__renderDiag.prefs.getState().sidebarCollapsed");
	let installed = false;
	try {
		// Stay below the chat column max-width so sidebar toggles must really resize the field.
		await main.eval(
			`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].setSize(900,${bounds.height})`,
		);
		await renderer.eval("__renderDiag.prefs.setState({sidebarCollapsed:false})");
		await send(events);
		await pause(500);
		await renderer.eval(`
		__renderDiag.particleOriginal = SVGElement.prototype.getBoundingClientRect;
		__renderDiag.particleReads = 0;
		__renderDiag.particleRecording = true;
		__renderDiag.particleHost = document.querySelector(".status-particles");
		__renderDiag.particleAnimations = [...__renderDiag.particleHost.querySelectorAll(".status-particle-group")].map(g => g.getAnimations()[0]);
		__renderDiag.particleTimes = __renderDiag.particleAnimations.map(a => a.currentTime);
		SVGElement.prototype.getBoundingClientRect = function() {
			if (__renderDiag.particleRecording && this.matches(".status-particles")) __renderDiag.particleReads++;
			return __renderDiag.particleOriginal.call(this);
		};
	`);
		installed = true;
		const inspect = () =>
			renderer.eval(`(() => {
		const d = __renderDiag;
		d.particleRecording = false;
		const host = document.querySelector(".status-particles");
		const animations = [...host.querySelectorAll(".status-particle-group")].map(g => g.getAnimations()[0]);
		const rect = host.getBoundingClientRect();
		const result = {
			hostSame: host === d.particleHost,
			animationsSame: animations.length === 9 && animations.every((a, i) => a === d.particleAnimations[i]),
			phaseAdvanced: animations.every((a, i) => a.currentTime > d.particleTimes[i]),
			particles: host.querySelectorAll("circle").length,
			height: rect.height,
			width: rect.width,
			reads: d.particleReads,
		};
		d.particleRecording = true;
		return result;
	})()`);
		const verify = (sample) => {
			assert(
				sample.hostSame && sample.animationsSame,
				"Status particles must persist through layout changes",
			);
			assert(sample.phaseAdvanced, "Status particle phases must advance without restarting");
			assert(
				sample.particles > 0 && sample.particles <= 270 && sample.height === 24,
				"Bounded one-line particles",
			);
		};
		await pause(650);
		const stationary = await inspect();
		verify(stationary);
		assert(
			stationary.reads <= 2,
			`Stationary particle geometry should not be read per frame, got ${stationary.reads}`,
		);
		const sample = await snapshot("particles-stationary", round);
		sample.particleGeometry = stationary;
		let previousWidth = stationary.width;
		for (const collapsed of [true, false, true, false]) {
			await renderer.eval(
				`__renderDiag.particleReads=0;__renderDiag.prefs.setState({sidebarCollapsed:${collapsed}})`,
			);
			await pause(500);
			const geometry = await inspect();
			verify(geometry);
			assert(
				Math.abs(geometry.width - previousWidth) > 10,
				"Sidebar toggle must actually resize the particle field",
			);
			previousWidth = geometry.width;
			const sample = await snapshot(collapsed ? "particles-sidebar-close" : "particles-sidebar-open", round);
			sample.particleGeometry = geometry;
		}
	} finally {
		if (installed)
			await renderer.eval(`
			SVGElement.prototype.getBoundingClientRect=__renderDiag.particleOriginal;
			delete __renderDiag.particleAnimations;
			delete __renderDiag.particleHost;
			delete __renderDiag.particleOriginal;
			delete __renderDiag.particleTimes;
			__renderDiag.particleRecording=false;
		`);
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
		await renderer.eval(`__renderDiag.prefs.setState({sidebarCollapsed:${collapsedBefore}})`);
		await main.eval(
			`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].setBounds(${JSON.stringify(bounds)})`,
		);
		await pause(400);
		assert(
			await renderer.eval('!document.querySelector(".status-particles")'),
			"Probe must leave a settled session before subsequent samples",
		);
	}
}
