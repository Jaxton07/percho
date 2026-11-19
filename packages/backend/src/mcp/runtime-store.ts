import { randomUUID } from "node:crypto";
import type { McpRuntimeSnapshot } from "@earendil-works/pi-coding-agent";
import type { McpRuntimeInstance, McpRuntimeInventory } from "@percho/shared";

/** One owner per SDK session construction; each factory invocation is a new generation. */
export class McpRuntimeStore {
	private readonly epoch = randomUUID();
	private revision = 0;
	private readonly instances = new Map<object, McpRuntimeInstance>();
	constructor(private readonly emit: (inventory: McpRuntimeInventory) => void) {}
	snapshot(): McpRuntimeInventory {
		return { epoch: this.epoch, revision: this.revision, instances: [...this.instances.values()] };
	}
	private changed(): void {
		this.revision++;
		this.emit(this.snapshot());
	}
	owner(cwd: string) {
		const key = {};
		let sessionId: string | undefined;
		let active = true;
		let generation = 0;
		let current: McpRuntimeSnapshot | undefined;
		let instanceId = randomUUID();
		const publish = () => {
			if (!active || !sessionId) return;
			this.instances.set(key, {
				instanceId,
				sessionId,
				cwd,
				available: !!current,
				servers: current?.servers ?? [],
				errors: current?.errors ?? [],
				notice: current?.notice,
			});
			this.changed();
		};
		return {
			bind: (id: string) => {
				sessionId = id;
				publish();
			},
			observer: () => {
				const token = ++generation;
				let closed = false;
				return (snapshot: McpRuntimeSnapshot) => {
					if (!active || token !== generation || closed) return;
					if (snapshot.phase === "closed") {
						closed = true;
						current = undefined;
						if (this.instances.delete(key)) this.changed();
						return;
					}
					if (snapshot.phase === "starting") instanceId = randomUUID();
					current = snapshot;
					publish();
				};
			},
			ensurePresent: () => {
				if (!active || this.instances.has(key)) return;
				current = undefined;
				instanceId = randomUUID();
				publish();
			},
			close: () => {
				active = false;
				if (this.instances.delete(key)) this.changed();
			},
		};
	}
}
