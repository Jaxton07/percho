import { ChannelDatabaseService, type ChannelService } from "./service";
import type { ChannelFence, DeleteFingerprint } from "./types";

export type { DeleteFingerprint } from "./types";

/** Backend discovery uses the shared database, never probes project directories. */
export class ChannelBackendHost {
	private readonly database: ChannelDatabaseService;
	constructor(
		agentDir: string,
		private readonly service: (root: string) => ChannelService,
		database?: ChannelDatabaseService,
	) {
		this.database = database ?? new ChannelDatabaseService({ agentDir });
	}
	deleteFingerprint(root: string, opId: string): Promise<DeleteFingerprint | null | undefined> {
		return this.database.deleteFingerprint(root, opId);
	}
	recordDeleteFingerprint(root: string, opId: string, fingerprint: DeleteFingerprint | null): Promise<void> {
		return this.database.recordDeleteFingerprint(root, opId, fingerprint);
	}
	register(root: string): Promise<void> {
		return this.database.register(root);
	}
	binding(id: string): Promise<{ root: string; cwd: string } | undefined> {
		return this.database.binding(id);
	}
	bind(id: string, root: string, cwd: string): Promise<void> {
		return this.database.bind(id, root, cwd);
	}
	async fences(): Promise<Array<{ service: ChannelService; fence: ChannelFence }>> {
		return (await this.database.fences()).map(({ projectRoot, ...fence }) => ({
			service: this.service(projectRoot),
			fence,
		}));
	}
	async find(
		sessionId: string,
		source: string,
	): Promise<{ service: ChannelService; fence: ChannelFence } | undefined> {
		const match = await this.database.find(sessionId, source);
		if (!match) return undefined;
		const { projectRoot, ...fence } = match;
		return { service: this.service(projectRoot), fence };
	}
	close(): Promise<void> {
		return this.database.close();
	}
}
