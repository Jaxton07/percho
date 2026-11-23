/** Check the actual SDK-event status row and its shared animation through layout changes. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function measureStatusParticles(renderer, main, channel, snapshot, round) {
	const pause = (ms) => new Promise((r) => setTimeout(r, ms));
	const sid = await renderer.eval("__renderDiag.sid");
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
	const waitFor = async (expression, message, timeout = 10000) => {
		const end = Date.now() + timeout;
		while (!(await renderer.eval(`Boolean(${expression})`))) {
			assert(Date.now() < end, message);
			await pause(20);
		}
	};
	await waitFor(
		"(()=>{const e=document.querySelector('.chat-scrollbar');return Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop)<=2})()",
		"Real wheel must reach the bottom",
	);
	const send = (events) =>
		main.eval(
			`(()=>{const win=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0];for(const event of ${JSON.stringify(events)})win.webContents.send(${JSON.stringify(channel)},{sessionId:${JSON.stringify(sid)},event});return true})()`,
		);
	const bounds = await main.eval(
		"process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].getBounds()",
	);
	const collapsedBefore = await renderer.eval("__renderDiag.prefs.getState().sidebarCollapsed");
	const visualBefore = await renderer.eval(
		"({language:__renderDiag.core.i18n?.getState().language,dark:document.documentElement.classList.contains('dark'),size:__renderDiag.prefs.getState().uiFontSize})",
	);
	let installed = false;
	try {
		await main.eval(
			`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].setSize(900,${bounds.height})`,
		);
		await renderer.eval("__renderDiag.prefs.setState({sidebarCollapsed:false})");
		await send([
			{ type: "agent_start" },
			{ type: "turn_start" },
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "bash" }] },
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"command":"echo geometry"}',
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { id: "geometry-probe", name: "bash", arguments: { command: "echo geometry" } },
				},
			},
			{
				type: "tool_execution_start",
				toolCallId: "geometry-probe",
				toolName: "bash",
				args: { command: "echo geometry" },
			},
		]);
		await waitFor(
			"document.querySelector('.activity-status[data-phase=enter]')",
			"Status row must enter via SDK events",
		);
		const enter = await renderer.eval(
			"(()=>{const r=document.querySelector('.activity-status'),a=r.querySelector('.activity-status-words').getAnimations()[0];return {duration:a?.effect.getTiming().duration,iterations:a?.effect.getTiming().iterations}})()",
		);
		assert.equal(enter.duration, 600, "Entry duration must be 600ms");
		assert.equal(enter.iterations, 1);
		await waitFor(
			"document.querySelector('.activity-status[data-phase=pass]')",
			"Entry must lead to a complete pass",
		);
		await renderer.eval(
			`(()=>{const d=__renderDiag;d.particleHost=document.querySelector('.activity-status');d.particleOriginal=SVGElement.prototype.getBoundingClientRect;d.particleReads=0;d.particleRecording=true;SVGElement.prototype.getBoundingClientRect=function(){if(d.particleRecording&&this.matches('.status-particles'))d.particleReads++;return d.particleOriginal.call(this)}})()`,
		);
		installed = true;
		const inspect = () =>
			renderer.eval(`(()=>{
			const d=__renderDiag,r=document.querySelector('.activity-status'),svg=r?.querySelector('.status-particles');
			if(!svg)return null;
			d.particleRecording=false;
			const text=r.querySelector('.activity-status-words'),label=r.querySelector('.activity-status-label'),mask=svg.querySelector('mask rect'),glow=svg.querySelector('.activity-status-highlight');
			const tr=text.getBoundingClientRect(),pr=svg.getBoundingClientRect(),gap=Math.max(0,pr.left-tr.right),width=tr.width+gap+pr.width;
			const tracks=[label,mask,glow].map(e=>e.getAnimations()[0]);
			const ids=[...r.querySelectorAll('[id]')].map(e=>e.id);
			const result={same:r===d.particleHost,phase:r.dataset.phase,text:label.textContent,left:pr.left,width:pr.width,height:pr.height,textWidth:tr.width,gap,distance:width,particles:svg.querySelectorAll('circle').length,uses:svg.querySelectorAll('use').length,idsUnique:ids.every(id=>document.querySelectorAll('#'+CSS.escape(id)).length===1),reads:d.particleReads,tracks:tracks.map(a=>a&&({duration:a.effect.getTiming().duration,iterations:a.effect.getTiming().iterations,start:a.startTime,time:a.currentTime,frames:a.effect.getKeyframes()}))};
			d.particleRecording=true;return result;
		})()`);
		const verify = (s) => {
			assert(s?.same && s.phase === "pass", "Outer status row must remain in a pass");
			assert(
				s.particles > 0 && s.particles <= 270 && s.height === 24 && s.uses === 2 && s.idsUnique,
				"Bounded particles and unique SVG references",
			);
			assert(s.tracks.every(Boolean), "Text, mask and breathing tracks must all run");
			const duration = Math.max(1600, Math.round(((s.distance + 160) / 360) * 1000));
			assert(
				s.tracks.every((t) => t.duration === duration && t.iterations === 1 && t.start === s.tracks[0].start),
				`Tracks must share the same clock and calculated duration: ${JSON.stringify(s)}`,
			);
			assert.equal(s.tracks[0].frames.length, 2, "Text sweep must be continuous");
			assert.equal(s.tracks[1].frames.length, 2, "Mask sweep must be continuous");
			assert(
				s.tracks[0].frames[0].backgroundPosition.includes("-160px") &&
					s.tracks[1].frames[0].transform.includes("translateX"),
				"Sweep must start outside the text and particle field",
			);
			const x = (value) => Number.parseFloat(value.match(/-?[\d.]+/)[0]);
			assert(
				Math.abs(x(s.tracks[0].frames[1].backgroundPosition) - s.distance) < 0.1,
				"Text must sweep to the end of the entire row",
			);
			assert(
				Math.abs(x(s.tracks[1].frames[0].transform) + 160 + s.textWidth + s.gap) < 0.1 &&
					Math.abs(x(s.tracks[1].frames[1].transform) - s.width) < 0.1,
				"Mask must traverse the same continuous distance",
			);
		};
		const initial = await inspect();
		verify(initial);
		await renderer.eval(
			"__renderDiag.particleTracks=[...document.querySelector('.activity-status').getAnimations({subtree:true})];true",
		);
		// A different tool supplies a new candidate while the first pass is in flight.
		await send([
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 1,
					partial: { content: [{ type: "toolCall", name: "read" }] },
				},
			},
			{
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"geometry.txt"}' },
			},
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { id: "geometry-read", name: "read", arguments: { path: "geometry.txt" } },
				},
			},
			{
				type: "tool_execution_start",
				toolCallId: "geometry-read",
				toolName: "read",
				args: { path: "geometry.txt" },
			},
		]);
		// Output growth is delivered through the real event bridge while the same sentence is displayed.
		for (let i = 0; i < 4; i++)
			await send([
				{
					type: "tool_execution_update",
					toolCallId: "geometry-probe",
					toolName: "bash",
					partialResult: `synthetic output ${"x".repeat(i * 100)}`,
				},
			]);
		await pause(250);
		const stationary = await inspect();
		verify(stationary);
		assert.equal(stationary.text, initial.text);
		assert.equal(
			stationary.tracks[0].start,
			initial.tracks[0].start,
			"Same-pass updates must not restart the clock",
		);
		assert(stationary.tracks[0].time > initial.tracks[0].time, "Clock must advance");
		assert(
			Math.abs(stationary.left - initial.left) < 0.5 &&
				Math.abs(stationary.width - initial.width) < 0.5 &&
				Math.abs(stationary.textWidth - initial.textWidth) < 0.5,
			"Unshown updates must not move the particle geometry",
		);
		assert(
			stationary.reads <= 2,
			`Stationary particle geometry should not be read per frame, got ${stationary.reads}`,
		);
		await waitFor(
			`document.querySelector('.activity-status-label')?.textContent !== ${JSON.stringify(initial.text)}`,
			"Latest candidate must eventually be displayed",
			10000,
		);
		const sample = await snapshot("particles-stationary", round);
		sample.particleGeometry = stationary;
		let previousWidth = stationary.width;
		for (const collapsed of [true, false, true, false]) {
			await renderer.eval(
				`__renderDiag.particleReads=0;__renderDiag.prefs.setState({sidebarCollapsed:${collapsed}})`,
			);
			await pause(500);
			await waitFor(
				"document.querySelector('.activity-status[data-phase=pass]')",
				"Resize must return to a pass",
			);
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
		if (visualBefore.language) {
			for (const language of ["zh", "en"]) {
				await renderer.eval(`__renderDiag.core.i18n.setState({language:${JSON.stringify(language)}});true`);
				await waitFor(
					`document.querySelector('.activity-status-label')?.textContent === ${JSON.stringify(language === "en" ? "Reviewing relevant content" : "正在查看相关内容")}`,
					"Language switch must translate the current activity",
				);
				for (const dark of [false, true]) {
					await renderer.eval(
						`document.documentElement.classList.toggle('dark',${dark});__renderDiag.prefs.getState().setUiFontSize(16);true`,
					);
					await renderer.send("Emulation.setDeviceMetricsOverride", {
						width: 390,
						height: 844,
						deviceScaleFactor: 1,
						mobile: false,
					});
					await pause(100);
					assert(
						await renderer.eval(
							"(()=>{const r=document.querySelector('.activity-status'),w=r.querySelector('.activity-status-words');return w.getBoundingClientRect().width<=r.getBoundingClientRect().width*.61&&document.documentElement.scrollWidth<=innerWidth})()",
						),
						"Both languages must fit a narrow viewport at a larger font",
					);
					const folder = join(process.env.PERCHO_RENDERING_ROOT, "inline-status-screenshots");
					await mkdir(folder, { recursive: true });
					const screenshot = await renderer.send("Page.captureScreenshot", { format: "png" });
					await writeFile(
						join(folder, `status-${round}-${language}-${dark ? "dark" : "light"}.png`),
						Buffer.from(screenshot.data, "base64"),
					);
				}
			}
		}
		// Real bridge events also cover an elapsed command and a cross-message subagent.
		if (visualBefore.language) {
			await renderer.eval('__renderDiag.core.i18n.setState({language:"en"});true');
			const call = (name, id, index, args) => [
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_start",
						contentIndex: index,
						partial: { content: [{ type: "toolCall", name }] },
					},
				},
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_end",
						contentIndex: index,
						toolCall: { id, name, arguments: args },
					},
				},
				{ type: "tool_execution_start", toolCallId: id, toolName: name, args },
			];
			const id = `elapsed-${round}`;
			await send(call("codemode", id, 2, { code: "synthetic long execution" }));
			await waitFor(
				"document.querySelector('.activity-status-label')?.textContent === 'Running a command'",
				"Command must display before its deadline",
			);
			const readStart = () =>
				renderer.eval(
					`__renderDiag.transcripts.getState().bySession[__renderDiag.sid].streaming.tools.find(t=>t.id===${JSON.stringify(id)})?.startedAt`,
				);
			const start = await readStart();
			assert(Number.isFinite(start), "Only a real live start may begin the command clock");
			await send([
				{
					type: "tool_execution_update",
					toolCallId: id,
					toolName: "codemode",
					partialResult: { content: [{ type: "text", text: "still producing output" }] },
				},
			]);
			assert.equal(await readStart(), start, "Output must not reset the execution clock");
			await waitFor(
				"document.querySelector('.activity-status-label')?.textContent === 'Waiting for the command to finish'",
				"Elapsed command must reach the waiting candidate",
				15000,
			);
			assert(
				await renderer.eval(`Date.now()-${start}>10000`),
				"Waiting must not appear before the actual threshold",
			);
			await renderer.eval('__renderDiag.core.i18n.setState({language:"zh"});true');
			await waitFor(
				"document.querySelector('.activity-status-label')?.textContent === '正在等待命令执行完成'",
				"Waiting must be localized during execution",
			);
			assert.equal(await readStart(), start, "Changing language must not reset the execution clock");
			await send([
				{
					type: "tool_execution_end",
					toolCallId: id,
					toolName: "codemode",
					isError: false,
					result: { content: [{ type: "text", text: "done" }] },
				},
				{
					type: "tool_execution_end",
					toolCallId: "geometry-read",
					toolName: "read",
					isError: false,
					result: { content: [] },
				},
				{
					type: "tool_execution_end",
					toolCallId: "geometry-probe",
					toolName: "bash",
					isError: false,
					result: { content: [] },
				},
				{ type: "turn_end", message: { role: "assistant", content: [], stopReason: "toolUse" } },
				{ type: "turn_start" },
				{ type: "message_start", message: { role: "assistant", content: [] } },
			]);
			await renderer.eval('__renderDiag.core.i18n.setState({language:"en"});true');
			const child = `subagent-${round}`;
			await send(call("subagent", child, 0, { tasks: [{ task: "synthetic child" }] }));
			await send([
				{
					type: "tool_execution_update",
					toolCallId: child,
					toolName: "subagent",
					partialResult: {
						details: {
							results: [{ agent: "worker", task: "synthetic child", status: "running", exitCode: -1 }],
						},
					},
				},
			]);
			await waitFor(
				"document.querySelector('.activity-status-label')?.textContent === 'Waiting for subagent tasks to finish'",
				"A new-message subagent must outrank the previous message tool",
				7000,
			);
			await send([
				{
					type: "tool_execution_end",
					toolCallId: child,
					toolName: "subagent",
					isError: false,
					result: {
						content: [],
						details: { results: [{ agent: "worker", task: "synthetic child", status: "done", exitCode: 0 }] },
					},
				},
			]);
		}
	} catch (error) {
		console.error("Status particle verification failed:", error);
		console.error(
			"Activity diagnostics",
			await renderer.eval(
				"(()=>{const d=__renderDiag,s=d.transcripts.getState().bySession[d.sid];return {labels:[...document.querySelectorAll('.activity-status-label')].map(e=>e.textContent),active:s.agentActive,streaming:s.streaming&&{id:s.streaming.id,textBlockIndex:s.streaming.textBlockIndex,tools:s.streaming.tools.map(t=>({id:t.id,name:t.name,blockIndex:t.blockIndex,state:t.state})),placements:s.streaming.subagentByToolCallId,runs:s.streaming.subagentRuns.map(r=>r.status)},messages:s.messages.slice(-2).map(m=>({id:m.id,kind:m.kind,tools:m.tools?.map(t=>({name:t.name,blockIndex:t.blockIndex,state:t.state}))}))}})()",
			),
		);
		throw error;
	} finally {
		await renderer.send("Emulation.clearDeviceMetricsOverride");
		await renderer.eval(
			`if (__renderDiag.core.i18n) __renderDiag.core.i18n.setState({language:${JSON.stringify(visualBefore.language)}});document.documentElement.classList.toggle("dark",${visualBefore.dark});__renderDiag.prefs.getState().setUiFontSize(${visualBefore.size});true`,
		);
		if (installed)
			await renderer.eval(
				"SVGElement.prototype.getBoundingClientRect=__renderDiag.particleOriginal;delete __renderDiag.particleOriginal;delete __renderDiag.particleHost;delete __renderDiag.particleReads;delete __renderDiag.particleRecording",
			);
		await send([
			{
				type: "tool_execution_end",
				toolCallId: "geometry-probe",
				toolName: "bash",
				isError: false,
				result: { content: [{ type: "text", text: "synthetic" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "geometry-read",
				toolName: "read",
				isError: false,
				result: { content: [{ type: "text", text: "synthetic" }] },
			},
			{ type: "agent_end", messages: [], willRetry: false },
		]);
		await renderer.eval(`__renderDiag.prefs.setState({sidebarCollapsed:${collapsedBefore}})`);
		await main.eval(
			`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].setBounds(${JSON.stringify(bounds)})`,
		);
		await waitFor("!document.querySelector('.activity-status')", "Probe must leave a settled session");
		if (installed) {
			assert(
				await renderer.eval("(__renderDiag.particleTracks ?? []).every(a=>a.playState==='idle')"),
				"Unmount must cancel the retained animation tracks",
			);
			await renderer.eval("delete __renderDiag.particleTracks");
		}
	}
}
