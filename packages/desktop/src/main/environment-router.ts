import {
	type AnyChannelDef,
	CHANNEL_TABLE,
	type EnvironmentInvocation,
	type EnvironmentMethod,
	type EnvironmentRef,
	environmentKey,
	environmentRef,
} from "@percho/shared";

export interface EnvironmentExecutor {
	invoke(method: EnvironmentMethod, args: unknown): unknown | Promise<unknown>;
}

/** A registered target, never a mutable "current backend". Business identities come from the IPC table. */
export class EnvironmentRouter {
	private readonly channels = new Map<string, { method: string; def: AnyChannelDef }>(
		Object.entries(CHANNEL_TABLE).map(([method, def]) => [def.channel, { method, def }]),
	);
	private readonly local = new Map<string, (args: unknown) => unknown>();
	private remote: { key: string; executor: EnvironmentExecutor } | undefined;

	registerLocal(channel: string, handler: (args: unknown) => unknown): void {
		if (!this.channels.has(channel)) throw new Error("Unknown execution channel");
		if (this.local.has(channel)) throw new Error(`Execution handler already registered: ${channel}`);
		this.local.set(channel, handler);
	}

	attach(environment: EnvironmentRef, executor: EnvironmentExecutor): () => void {
		const ref = environmentRef(environment);
		if (ref.kind !== "ssh") throw new Error("The local execution environment cannot be replaced");
		if (this.remote) throw new Error("A remote execution environment is already attached");
		const target = { key: environmentKey(ref), executor };
		this.remote = target;
		return () => {
			if (this.remote === target) this.remote = undefined;
		};
	}

	invoke(channel: string, request: EnvironmentInvocation): unknown | Promise<unknown> {
		if (request.__perchoEnvironment !== 1) throw new Error("Invalid environment invocation");
		const entry = this.channels.get(channel);
		if (entry?.def.scope !== "environment") throw new Error("Method is not an execution method");
		const environment = environmentRef(request.environment);
		if (environment.kind === "local") {
			const handler = this.local.get(channel);
			if (!handler) throw new Error("Local execution handler is not available");
			return handler(request.args);
		}
		const target = this.remote;
		if (!target || target.key !== environmentKey(environment)) {
			throw new Error("Execution environment is not attached or its identity has changed");
		}
		return target.executor.invoke(entry.method as EnvironmentMethod, request.args);
	}
}

export const environmentRouter = new EnvironmentRouter();
