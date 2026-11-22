import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { JsonStore } from "../../json-store";
import type { ChannelService } from "./service";
import type { ChannelFence } from "./types";

type Binding = { root: string; cwd: string };
export type DeleteFingerprint = {
	dev: number;
	ino: number;
	ctimeMs: number;
	mtimeMs: number;
	id: string;
	archiveOperationId?: string | null;
};
type Registry = {
	projects: string[];
	bindings: Record<string, Binding>;
	deletes?: Record<string, DeleteFingerprint | null>;
	[key: string]: unknown;
};

/** Durable discovery and session bindings share one serialized authority. */
export class ChannelBackendHost {
	private readonly projects: JsonStore<Registry>;
	private readonly path: string;
	private readonly agentDir: string;
	constructor(
		agentDir: string,
		private readonly service: (root: string) => ChannelService,
	) {
		this.agentDir = agentDir;
		this.path = join(agentDir, "channel-projects.json");
		this.projects = new JsonStore<Registry>({
			path: this.path,
			defaultValue: () => ({ projects: [], bindings: {} }),
			durable: true,
			parse: (raw) => {
				const value: unknown = JSON.parse(raw);
				const registry = Array.isArray(value) ? { projects: value, bindings: {} } : value;
				if (!registry || typeof registry !== "object") throw new Error("Invalid channel project registry");
				const data = registry as Registry;
				const path = (item: unknown) =>
					typeof item === "string" && isAbsolute(item) && resolve(item) === item;
				if (
					!Array.isArray(data.projects) ||
					!data.projects.every(path) ||
					!data.bindings ||
					typeof data.bindings !== "object" ||
					Array.isArray(data.bindings)
				)
					throw new Error("Invalid channel project registry");
				for (const binding of Object.values(data.bindings)) {
					if (!binding || typeof binding !== "object" || !path(binding.root) || !path(binding.cwd))
						throw new Error("Invalid channel project binding");
				}
				return data;
			},
		});
	}
	private async update(fn: (data: Registry) => void, skip?: (data: Registry) => boolean): Promise<void> {
		await mkdir(this.agentDir, { recursive: true });
		const release = await lockfile.lock(this.path, {
			realpath: false,
			retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
		});
		try {
			if (skip?.(await this.projects.readStrict())) return;
			await this.projects.update(fn);
		} finally {
			await release();
		}
	}
	async deleteFingerprint(opId: string): Promise<DeleteFingerprint | null | undefined> {
		return (await this.projects.readStrict()).deletes?.[opId];
	}
	async recordDeleteFingerprint(opId: string, fingerprint: DeleteFingerprint | null): Promise<void> {
		await this.update((data) => {
			data.deletes ??= {};
			if (Object.hasOwn(data.deletes, opId)) throw new Error("Delete operation already exists");
			data.deletes[opId] = fingerprint;
		});
	}
	async register(root: string): Promise<void> {
		if ((await this.projects.readStrict()).projects.includes(root)) return;
		await this.update(
			(data) => {
				data.projects.push(root);
			},
			(data) => data.projects.includes(root),
		);
	}
	async binding(id: string): Promise<Binding | undefined> {
		return (await this.projects.readStrict()).bindings[id];
	}
	async bind(id: string, root: string, cwd: string): Promise<void> {
		await this.update((data) => {
			const existing = data.bindings[id];
			if (existing && (existing.root !== root || existing.cwd !== cwd))
				throw new Error("Session binding conflicts with another project");
			if (!data.projects.includes(root)) data.projects.push(root);
			data.bindings[id] = { ...existing, root, cwd };
		});
	}
	async fences(): Promise<Array<{ service: ChannelService; fence: ChannelFence }>> {
		const result: Array<{ service: ChannelService; fence: ChannelFence }> = [];
		for (const root of (await this.projects.readStrict()).projects) {
			const service = this.service(root);
			for (const fence of await service.pendingMaintenance()) result.push({ service, fence });
		}
		return result;
	}
	async find(
		sessionId: string,
		source: string,
	): Promise<{ service: ChannelService; fence: ChannelFence } | undefined> {
		const matches = (await this.fences()).filter(
			({ fence }) => fence.sessionId === sessionId && resolve(fence.source) === resolve(source),
		);
		if (matches.length > 1) throw new Error("Ambiguous channel maintenance source");
		return matches[0];
	}
}
