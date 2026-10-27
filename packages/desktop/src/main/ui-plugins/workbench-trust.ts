import type { UiPluginsConfig } from "@percho/shared";

/** Tracks delivered code for the renderer lifetime; disabling/removing it cannot undo execution. */
export class WorkbenchTrustDeclinedError extends Error {}
export class UiWorkbenchTrust {
	private readonly served = new Set<string>();
	private readonly approved = new Set<string>();
	private remoteExposed = false;
	private declined = false;
	private work: Promise<void> = Promise.resolve();
	constructor(
		private readonly read: () => Promise<UiPluginsConfig>,
		private readonly approve: (names: string[]) => Promise<void>,
		private readonly confirm: (names: string[]) => Promise<boolean>,
	) {}
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.work.then(operation);
		this.work = next.then(
			() => {},
			() => {},
		);
		return next;
	}
	private async trust(names: string[]): Promise<void> {
		const config = await this.read();
		const missing = [...new Set(names)].filter(
			(name) => !this.approved.has(name) && config.plugins[name]?.workbenchTrusted !== true,
		);
		if (!missing.length) return;
		if (!(await this.confirm(missing)))
			throw new WorkbenchTrustDeclinedError(
				"Workbench plugin trust was declined; local work remains available",
			);
		await this.approve(missing);
		for (const name of missing) this.approved.add(name);
	}
	resetDecline(): void {
		this.declined = false;
	}
	authorizeRemote(): Promise<void> {
		return this.enqueue(async () => {
			if (this.declined)
				throw new WorkbenchTrustDeclinedError(
					"Workbench plugin trust was declined; reconnect explicitly to review it",
				);
			const config = await this.read();
			try {
				await this.trust([
					...this.served,
					...Object.keys(config.plugins).filter(
						(name) => config.enabled && config.plugins[name]?.enabled && config.plugins[name]?.trusted,
					),
				]);
			} catch (error) {
				this.declined = true;
				throw error;
			}
			this.remoteExposed = true;
		});
	}
	authorizeEnable(name: string): Promise<void> {
		return this.enqueue(() => this.trust([name]));
	}
	configurePlugin(name: string, enabled: boolean, write: () => Promise<void>): Promise<boolean> {
		return this.enqueue(async () => {
			if (enabled) {
				try {
					await this.trust([name]);
				} catch (error) {
					if (error instanceof WorkbenchTrustDeclinedError) return false;
					throw error;
				}
			}
			await write();
			return true;
		});
	}
	serve<T>(name: string, readCode: () => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			if (this.remoteExposed) await this.trust([name]);
			const result = await readCode();
			if (result && typeof result === "object" && "code" in result && typeof result.code === "string")
				this.served.add(name);
			return result;
		});
	}
}
