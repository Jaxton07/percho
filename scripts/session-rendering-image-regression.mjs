/** Delayed thumbnail + real upward wheel. Inline synthetic pixels only; no user files. */
import assert from "node:assert/strict";
export async function verifyLateImage(renderer, snapshot, round) {
	const pause = (ms) => new Promise((r) => setTimeout(r, ms));
	await renderer.eval(
		`(()=>{const d=__renderDiag;d.originalImagePost=Worker.prototype.postMessage;d.imageDelayStarted=false;Worker.prototype.postMessage=function(...args){if(args[0]?.maxSide&&!d.imageDelayStarted){d.imageDelayStarted=true;const worker=this;d.imageDelayTimer=setTimeout(()=>d.originalImagePost.apply(worker,args),1500);return;}return d.originalImagePost.apply(this,args)};const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=1500;canvas.getContext('2d').fillRect(0,0,1000,1500);const image={data:canvas.toDataURL('image/png').split(',')[1],mimeType:'image/png'};d.transcripts.setState(state=>{const s=state.bySession[d.sid];return{bySession:{...state.bySession,[d.sid]:{...s,messages:[...s.messages,{kind:'image',id:'late-image',images:[image],paths:[],timestamp:3}]}}}})})()`,
	);
	try {
		const end = Date.now() + 10000;
		while (!(await renderer.eval("__renderDiag.imageDelayStarted"))) {
			assert(Date.now() < end, "Thumbnail request did not start");
			await pause(50);
		}
		await pause(500);
		const point = await renderer.eval(
			"(()=>{const r=document.querySelector('.chat-scrollbar').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()",
		);
		await renderer.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -60 });
		await pause(150);
		const before = await renderer.eval(
			"(()=>{const e=document.querySelector('[data-chat-row-key=\"late-image\"] [data-history-image]'),r=e.getBoundingClientRect();return{top:r.top,height:r.height,status:e.dataset.historyImage}})()",
		);
		assert.notEqual(before.status, "ready", "Probe must observe an actually delayed thumbnail");
		while (
			!(await renderer.eval(
				"document.querySelector('[data-chat-row-key=\"late-image\"] [data-history-image]')?.dataset.historyImage==='ready'",
			))
		) {
			assert(Date.now() < end, "Thumbnail did not become ready");
			await pause(50);
		}
		const after = await renderer.eval(
			"(()=>{const r=document.querySelector('[data-chat-row-key=\"late-image\"] [data-history-image]').getBoundingClientRect();return{top:r.top,height:r.height}})()",
		);
		assert(Math.abs(after.top - before.top) < 1, "Late image must not pull the upward-scrolled source");
		assert.equal(after.height, before.height, "Thumbnail completion must preserve the box height");
		await snapshot("history-late-image-stable", round);
	} finally {
		await renderer.eval(
			"Worker.prototype.postMessage=__renderDiag.originalImagePost;clearTimeout(__renderDiag.imageDelayTimer);delete __renderDiag.originalImagePost;delete __renderDiag.imageDelayTimer",
		);
	}
}
