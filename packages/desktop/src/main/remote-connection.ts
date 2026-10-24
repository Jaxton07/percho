import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JsonStore, SshRuntimeConnection, validateSshAlias } from "@percho/backend";
import {
	type EnvironmentRef,
	type RemoteConnectionStatus,
	SUBSCRIPTION_TABLE,
	type SubscriptionPayload,
} from "@percho/shared";
import { app } from "electron";
import { environmentRouter } from "./environment-router";
import { sendToRenderer } from "./ipc/send";

interface SavedConnection {
	connectionId: string;
	alias: string;
	environmentId: string;
	uid: number;
	canonicalAgentDir: string;
}
const store = () =>
	new JsonStore<SavedConnection | null>({
		path: join(app.getPath("userData"), "remote-connection.json"),
		defaultValue: () => null,
	});

class RemoteConnectionManager {
	private status: RemoteConnectionStatus = { revision: 0, state: "disconnected" };
	private generation = 0;
	private controller?: AbortController;
	private connection?: SshRuntimeConnection;
	private detach?: () => void;
	private readonly clientTag = randomUUID();
	private update(patch: Omit<RemoteConnectionStatus, "revision">): RemoteConnectionStatus {
		this.status = { ...patch, revision: this.status.revision + 1 };
		sendToRenderer(SUBSCRIPTION_TABLE.onRemoteConnectionStatus.channel, this.status);
		return this.status;
	}
	async getStatus(): Promise<RemoteConnectionStatus> {
		if (this.status.revision === 0) {
			const saved = await store().read();
			if (saved && this.status.revision === 0)
				this.update({
					state: "disconnected",
					alias: saved.alias,
					environment: { kind: "ssh", connectionId: saved.connectionId, environmentId: saved.environmentId },
				});
		}
		return this.status;
	}
	disconnect(): RemoteConnectionStatus {
		this.generation += 1;
		this.controller?.abort();
		this.controller = undefined;
		this.detach?.();
		this.detach = undefined;
		this.connection?.disconnect();
		this.connection = undefined;
		return this.update({
			state: "disconnected",
			alias: this.status.alias,
			environment: this.status.environment,
		});
	}
	async connect(alias: string): Promise<RemoteConnectionStatus> {
		validateSshAlias(alias);
		if (this.status.state === "connecting")
			throw new Error("A remote connection is already being established");
		if (this.connection) {
			if (alias === this.status.alias) return this.status;
			throw new Error("Disconnect the existing remote environment first");
		}
		const generation = ++this.generation;
		const controller = new AbortController();
		this.controller = controller;
		this.update({ state: "connecting", alias, environment: this.status.environment });
		let connection: SshRuntimeConnection | undefined;
		let transportClosed = false;
		try {
			const saved = await store().read();
			if (saved && saved.alias !== alias)
				throw new Error("This desktop is already bound to another SSH alias");
			const connectionId = saved?.connectionId ?? randomUUID();
			let environment: Extract<EnvironmentRef, { kind: "ssh" }> | undefined;
			connection = await SshRuntimeConnection.connect(alias, {
				signal: controller.signal,
				clientTag: this.clientTag,
				onEvent: (method, payload) => {
					if (!environment || generation !== this.generation) return;
					const definition = SUBSCRIPTION_TABLE[method as keyof typeof SUBSCRIPTION_TABLE];
					if (definition?.scope !== "environment") return;
					sendToRenderer(
						definition.channel,
						payload as SubscriptionPayload<typeof definition.channel>,
						environment,
					);
				},
				onClose: () => {
					transportClosed = true;
					if (generation !== this.generation || !this.connection) return;
					this.detach?.();
					this.detach = undefined;
					this.connection = undefined;
					this.update({
						state: "error",
						alias,
						environment: this.status.environment,
						error: "SSH connection closed",
					});
				},
			});
			const info = connection.info;
			if (
				saved &&
				(saved.environmentId !== info.environmentId ||
					saved.uid !== info.uid ||
					saved.canonicalAgentDir !== info.canonicalAgentDir)
			)
				throw new Error("Remote identity changed; existing projects cannot be rebound automatically");
			if (generation !== this.generation || controller.signal.aborted || transportClosed)
				throw new Error("Remote connection cancelled");
			await store().update(() => ({
				connectionId,
				alias,
				environmentId: info.environmentId,
				uid: info.uid,
				canonicalAgentDir: info.canonicalAgentDir,
			}));
			if (generation !== this.generation || controller.signal.aborted || transportClosed)
				throw new Error("Remote connection cancelled");
			environment = { kind: "ssh", connectionId, environmentId: info.environmentId };
			const target = connection;
			this.detach = environmentRouter.attach(environment, {
				invoke: (method, args) => target.invoke(method, args),
			});
			this.connection = connection;
			return this.update({ state: "connected", alias, environment });
		} catch (error) {
			connection?.disconnect();
			if (generation !== this.generation) return this.status;
			this.update({
				state: "error",
				alias,
				environment: this.status.environment,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
}

export const remoteConnectionManager = new RemoteConnectionManager();
