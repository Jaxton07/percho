/** Observe new resource ownership in a supplemental run, never in primary latency samples. */
export async function installResourceProbe(renderer) {
	await renderer.eval(`(()=>{
		const entries=[];
		const probe={entries,counts:()=>Object.fromEntries(entries.map(({name,owners})=>[name,{observers:owners.size,targets:[...owners.values()].reduce((n,s)=>n+s.size,0),disconnectedTargets:[...owners.values()].flatMap(s=>[...s]).filter(e=>!e.isConnected).length}]))};
		for(const name of ['ResizeObserver','MutationObserver','IntersectionObserver']){
			const prototype=window[name].prototype,owners=new Map(),original={observe:prototype.observe,unobserve:prototype.unobserve,disconnect:prototype.disconnect};
			prototype.observe=function(target,...options){const result=original.observe.call(this,target,...options);const targets=owners.get(this)??new Set();targets.add(target);owners.set(this,targets);return result;};
			if(original.unobserve)prototype.unobserve=function(target){const targets=owners.get(this);targets?.delete(target);if(!targets?.size)owners.delete(this);return original.unobserve.call(this,target);};
			prototype.disconnect=function(){owners.delete(this);return original.disconnect.call(this);};
			entries.push({name,prototype,owners,original});
		}
		__renderDiag.resources=probe;
	})()`);
}
export async function readResources(renderer) {
	return renderer.eval("__renderDiag.resources?.counts()??null");
}
export async function removeResourceProbe(renderer) {
	await renderer.eval(
		`(()=>{for(const {prototype,original,owners} of __renderDiag.resources?.entries??[]){Object.assign(prototype,original);owners.clear();}delete __renderDiag.resources;})()`,
	);
}
