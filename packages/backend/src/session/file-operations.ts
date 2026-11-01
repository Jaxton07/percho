import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** 同一来源的普通操作和维护共用一把门；不是另一个普通打开缓存。 */
export class SessionFileOperations {
	private readonly busy = new Map<string, { kind: string; token: object }>();
	key(file: string): string {
		try {
			return realpathSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return resolve(file);
		}
	}
	acquire(files: readonly string[], kind: string): { release: () => void; assert: () => void } {
		const keys = [...new Set(files.map((file) => this.key(file)))].sort();
		for (const key of keys) {
			const active = this.busy.get(key);
			if (active) throw new Error(`Session is busy (${active.kind})`);
		}
		const token = {};
		for (const key of keys) this.busy.set(key, { kind, token });
		return {
			assert: () => {
				if (keys.some((key) => this.busy.get(key)?.token !== token))
					throw new Error("Session operation lease expired");
			},
			release: () => {
				for (const key of keys) if (this.busy.get(key)?.token === token) this.busy.delete(key);
			},
		};
	}
	async run<T>(files: readonly string[], kind: string, work: () => Promise<T>): Promise<T> {
		const lease = this.acquire(files, kind);
		try {
			return await work();
		} finally {
			lease.release();
		}
	}
	has(file: string): boolean {
		return this.busy.has(this.key(file));
	}
}
