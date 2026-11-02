/** Supplemental real selection/copy-event + live IPC probe. System clipboard writes are intercepted. */
import assert from "node:assert/strict";
import { renderingFixture } from "./session-rendering-fixture.mjs";

export async function measureLiveSelection(renderer, snapshot, round, options) {
	const pause = (ms) => new Promise((r) => setTimeout(r, ms));
	const click = async (expression) => {
		const rect = await renderer.eval(`${expression}.getBoundingClientRect().toJSON()`);
		for (const type of ["mousePressed", "mouseReleased"])
			await renderer.send("Input.dispatchMouseEvent", {
				type,
				x: rect.x + 20,
				y: rect.y + 10,
				button: "left",
				clickCount: 1,
			});
	};
	await renderer.eval(
		"__renderDiag.selectedTool=__renderDiag.bigGroup.querySelector('details');__renderDiag.selectedTool.querySelector('summary').scrollIntoView({block:'center'})",
	);
	try {
		await pause(100);
		await click("__renderDiag.selectedTool.querySelector('summary')");
		await pause(400);
		await renderer.eval(
			"__renderDiag.selectedTool.querySelectorAll('pre')[1].scrollIntoView({block:'center'})",
		);
		const pre = await renderer.eval(
			"__renderDiag.selectedTool.querySelectorAll('pre')[1].getBoundingClientRect().toJSON()",
		);
		for (const [type, x] of [
			["mouseMoved", 2],
			["mousePressed", 2],
			["mouseMoved", 95],
			["mouseReleased", 95],
		])
			await renderer.send("Input.dispatchMouseEvent", {
				type,
				x: pre.x + x,
				y: pre.y + 8,
				button: "left",
				buttons: type === "mouseMoved" && x === 95 ? 1 : 0,
				clickCount: 1,
			});
		const selected = await renderer.eval("getSelection().toString()");
		assert(selected.length > 0, "Real drag must select output text");
		const copied = async () => {
			await renderer.eval(
				"__renderDiag.copied=null;__renderDiag.copyHandler=e=>{e.preventDefault();e.stopImmediatePropagation();__renderDiag.copied=getSelection().toString()};document.addEventListener('copy',__renderDiag.copyHandler,true)",
			);
			try {
				await renderer.send("Input.dispatchKeyEvent", {
					type: "keyDown",
					key: "c",
					code: "KeyC",
					modifiers: 4,
					commands: ["copy"],
				});
				await renderer.send("Input.dispatchKeyEvent", {
					type: "keyUp",
					key: "c",
					code: "KeyC",
					modifiers: 4,
				});
				assert.equal(
					await renderer.eval("__renderDiag.copied"),
					selected,
					"Native copy event must retain selected output",
				);
			} finally {
				await renderer.eval(
					"document.removeEventListener('copy',__renderDiag.copyHandler,true);delete __renderDiag.copyHandler",
				);
			}
		};
		await copied();
		const selectedSource = await renderer.eval(
			"(()=>{const d=__renderDiag,key=d.selectedTool.dataset.viewKey.slice(5);const tool=d.transcripts.getState().bySession[d.sid].messages.flatMap(m=>m.tools??[]).find(t=>t.key===key);return{id:tool.id,name:tool.name,output:tool.output}})()",
		);
		// A committed record is immutable in the event reducer; use the separately labelled local projection seam here.
		const appended = selectedSource.output + "\nappended output";
		await renderer.eval(
			`(()=>{const d=__renderDiag,key=d.selectedTool.dataset.viewKey.slice(5);d.transcripts.setState(state=>{const s=state.bySession[d.sid];return{bySession:{...state.bySession,[d.sid]:{...s,messages:s.messages.map(m=>m.kind==='assistant'&&m.tools.some(t=>t.key===key)?{...m,tools:m.tools.map(t=>t.key===key?{...t,output:${JSON.stringify(appended)}}:t)}:m)}}}})})()`,
		);
		await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
		assert.equal(
			await renderer.eval("__renderDiag.selectedTool.querySelectorAll('pre')[1].textContent"),
			appended,
			"Append probe must really change the displayed output",
		);
		assert.equal(
			await renderer.eval("getSelection().toString()"),
			selected,
			"Appending the selected output itself must retain its prefix selection",
		);
		await copied();
		const events = JSON.parse(
			JSON.stringify(renderingFixture(20)).replaceAll("synthetic-tool-", "browse-tool-"),
		).filter((e) => !(e.type === "message_start" && e.message.role === "user"));
		const sid = await renderer.eval("__renderDiag.sid");
		try {
			await options.main.eval(
				`(()=>{const d=globalThis.__renderBrowse={index:0,events:${JSON.stringify(events)}};const win=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0];d.timer=setInterval(()=>{if(d.index<d.events.length)win.webContents.send(${JSON.stringify(options.channel)},{sessionId:${JSON.stringify(sid)},event:d.events[d.index++]});if(d.index>=d.events.length)clearInterval(d.timer)},20);return true})()`,
			);
			await pause(1000);
			assert.equal(
				await renderer.eval("getSelection().toString()"),
				selected,
				"Unrelated live updates must retain the real selection",
			);
			await copied();
			await snapshot("history-live-selected-copy", round);
			const point = await renderer.eval(
				"(()=>{const e=document.querySelector('.chat-scrollbar'),r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()",
			);
			await renderer.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				...point,
				deltaX: 0,
				deltaY: -70,
			});
			await pause(150);
			const anchorTop = await renderer.eval("__renderDiag.selectedTool.getBoundingClientRect().top");
			await pause(150);
			assert(
				Math.abs((await renderer.eval("__renderDiag.selectedTool.getBoundingClientRect().top")) - anchorTop) <
					1,
				"Background growth must not pull the browsed source back to the bottom",
			);
			await snapshot("history-live-wheel-up", round);
			await renderer.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				...point,
				deltaX: 0,
				deltaY: 100000,
			});
			await pause(150);
			await snapshot("history-live-wheel-bottom", round);
			await renderer.eval(
				"__renderDiag.focusedComposer=document.querySelector('[contenteditable=true]');__renderDiag.focusedComposer.focus()",
			);
			const key = async (key, modifiers) => {
				const [code, windowsVirtualKeyCode] = {
					z: ["KeyZ", 90],
					a: ["KeyA", 65],
					Backspace: ["Backspace", 8],
				}[key];
				for (const type of ["keyDown", "keyUp"])
					await renderer.send("Input.dispatchKeyEvent", {
						type,
						key,
						code,
						windowsVirtualKeyCode,
						modifiers,
					});
			};
			await renderer.send("Input.insertText", { text: "draft" });
			await renderer.send("Input.imeSetComposition", { text: "性能", selectionStart: 2, selectionEnd: 2 });
			await renderer.send("Input.insertText", { text: "性能" });
			await pause(100);
			const composed = await renderer.eval("__renderDiag.focusedComposer.textContent");
			assert(composed.includes("性能"), "IME commit must enter the existing draft");
			await key("z", 4);
			await pause(50);
			assert.notEqual(
				await renderer.eval("__renderDiag.focusedComposer.textContent"),
				composed,
				"Native undo must change the composition result",
			);
			await key("z", 12);
			await pause(50);
			assert.equal(
				await renderer.eval("__renderDiag.focusedComposer.textContent"),
				composed,
				"Native redo must restore the composition result",
			);
			assert(
				await renderer.eval(
					"document.querySelector('[contenteditable=true]')===__renderDiag.focusedComposer",
				),
				"Background events must not replace the editor DOM",
			);
			await key("a", 4);
			await key("Backspace", 0);
			await renderer.eval("delete __renderDiag.focusedComposer");
			await snapshot("history-live-ime-undo", round);
			const end = Date.now() + 20000;
			while (!(await options.main.eval("__renderBrowse.index===__renderBrowse.events.length"))) {
				assert(Date.now() < end);
				await pause(100);
			}
			await pause(100);
		} finally {
			await options.main.eval(
				"clearInterval(globalThis.__renderBrowse?.timer);delete globalThis.__renderBrowse",
			);
		}
		// Native Range with both endpoints outside the tool still intersects its closing body.
		assert(
			await renderer.eval(
				"(()=>{const tool=__renderDiag.selectedTool,range=document.createRange(),selection=getSelection();range.setStartBefore(tool);range.setEndAfter(tool);selection.removeAllRanges();selection.addRange(range);return selection.toString().includes('Synthetic output')&&!tool.contains(selection.anchorNode)&&!tool.contains(selection.focusNode)})()",
			),
			"Cross-range fixture must contain tool output with both endpoints outside",
		);
		await renderer.eval("__renderDiag.selectedTool.querySelector('summary').click()");
		await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
		assert.equal(await renderer.eval("getSelection().toString()"), "", "Closing must clear a crossing range");
		await snapshot("history-cross-range-fold", round);
		await renderer.eval("__renderDiag.selectedTool.querySelector('summary').click()");
		await pause(400);
		await renderer.eval(
			"__renderDiag.selectedTool.querySelectorAll('pre')[1].scrollIntoView({block:'center'})",
		);
		const finalPre = await renderer.eval(
			"__renderDiag.selectedTool.querySelectorAll('pre')[1].getBoundingClientRect().toJSON()",
		);
		for (const [type, x] of [
			["mouseMoved", 2],
			["mousePressed", 2],
			["mouseMoved", 95],
			["mouseReleased", 95],
		])
			await renderer.send("Input.dispatchMouseEvent", {
				type,
				x: finalPre.x + x,
				y: finalPre.y + 8,
				button: "left",
				buttons: type === "mouseMoved" && x === 95 ? 1 : 0,
				clickCount: 1,
			});
		assert(
			(await renderer.eval("getSelection().toString()")).length > 0,
			"Fold check must begin with a real detail selection",
		);
		await renderer.eval("__renderDiag.bigGroup.querySelector('summary').scrollIntoView({block:'center'})");
		const openHeight = await renderer.eval("__renderDiag.bigGroup.getBoundingClientRect().height");
		await click("__renderDiag.bigGroup.querySelector('summary')");
		await pause(100);
		const closing = await renderer.eval(
			"({height:__renderDiag.bigGroup.getBoundingClientRect().height,summary:__renderDiag.bigGroup.querySelector('summary').getBoundingClientRect().height,children:__renderDiag.bigGroup.querySelectorAll('details').length})",
		);
		assert(
			closing.height < openHeight && closing.height > closing.summary + 1 && closing.children >= 500,
			"Original closing animation must retain its content and interpolate height",
		);
		await pause(400);
		if (options.after)
			assert.equal(
				await renderer.eval("__renderDiag.bigGroup.querySelectorAll('details').length"),
				0,
				"Folded group must release nested details after the original exit",
			);
		assert.equal(
			await renderer.eval("getSelection().toString()"),
			"",
			"Active folding must clear its selection",
		);
		return snapshot("history-group-folded", round);
	} finally {
		await renderer.eval("delete __renderDiag.selectedTool");
	}
}
