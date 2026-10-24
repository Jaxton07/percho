import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	checkSshRequirements,
	installSshRuntime,
	JsonStore,
	preflightSsh,
	RemoteMutationUnknownError,
	remoteAuthGuide,
	SshRuntimeConnection,
	sshFailureKind,
	validateSshAlias,
} from "@percho/backend";
import {
	type EnvironmentRef,
	type MutationReceipt,
	type RemoteConnectionStatus,
	type SshPreflight,
	SUBSCRIPTION_TABLE,
	type SubscriptionPayload,
	sameEnvironment,
	type UncertainRemoteOperation,
} from "@percho/shared";
import { app } from "electron";
import { environmentRouter } from "./environment-router";
import { sendToRenderer } from "./ipc/send";
import {
	downloadRuntimeArtifact,
	type RuntimeManifest,
	readRuntimeManifest,
} from "./remote-runtime-download";

interface SavedConnection {
	connectionId: string;
	alias: string;
	environmentId: string;
	uid: number;
	canonicalAgentDir: string;
	node?: string;
	releaseId?: string;
	target?: SshPreflight["target"];
}
const store = () =>
	new JsonStore<SavedConnection | null>({
		path: join(app.getPath("userData"), "remote-connection.json"),
		defaultValue: () => null,
	});

class InvalidSavedConnectionError extends Error {}
async function readSaved(): Promise<SavedConnection | null> {
	const value = await store().read();
	if (value === null) return null;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value.connectionId !== "string" ||
		!value.connectionId ||
		typeof value.environmentId !== "string" ||
		!value.environmentId ||
		!Number.isInteger(value.uid) ||
		value.uid < 0 ||
		typeof value.canonicalAgentDir !== "string" ||
		!value.canonicalAgentDir.startsWith("/") ||
		typeof value.alias !== "string" ||
		(value.node !== undefined && (typeof value.node !== "string" || !value.node.startsWith("/")))
	)
		throw new InvalidSavedConnectionError("Saved SSH connection is invalid; remove it before reconnecting");
	try {
		validateSshAlias(value.alias);
	} catch {
		throw new InvalidSavedConnectionError("Saved SSH alias is invalid; remove it before reconnecting");
	}
	if (
		value.target &&
		(typeof value.target.hostname !== "string" ||
			typeof value.target.user !== "string" ||
			typeof value.target.port !== "string")
	)
		throw new InvalidSavedConnectionError("Saved SSH target is invalid; remove it before reconnecting");
	return value;
}

export class RemoteConnectionManager {
	private installation?: { token: string; probe: SshPreflight; manifest: RuntimeManifest; archive: string };
	constructor(
		private readonly distribution = {
			manifest: () =>
				readRuntimeManifest(
					app.isPackaged
						? join(process.resourcesPath, "remote-runtime/manifest.json")
						: join(app.getAppPath(), "resources/remote-runtime/manifest.json"),
				),
			download: (item: RuntimeManifest["artifacts"]["arm64"], signal: AbortSignal) =>
				downloadRuntimeArtifact(item, join(app.getPath("userData"), "runtime-downloads"), signal),
			install: installSshRuntime,
		},
	) {}
	private status: RemoteConnectionStatus = { revision: 0, state: "disconnected" };
	private generation = 0;
	private autoConnect = true;
	private retryCount = 0;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private authorize: () => Promise<void> = async () => {};
	startAutoConnect(authorize: () => Promise<void>): void {
		this.authorize = authorize;
		void this.getStatus()
			.then((status) => {
				if (this.autoConnect && status.alias && status.state === "disconnected")
					void this.connect(status.alias, true).catch(() => {});
			})
			.catch(() => {});
	}
	private scheduleRetry(alias: string, ownBusy = false): void {
		if (!this.autoConnect || this.retryCount >= 5 || (!ownBusy && this.status.errorKind !== "network"))
			return;
		const delay = ownBusy ? 22_000 : Math.min(1000 * 2 ** this.retryCount, 16_000);
		this.retryCount++;
		this.update({ ...this.status, state: "reconnecting", retryAt: Date.now() + delay });
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.connect(alias, true).catch(() => {});
		}, delay);
	}
	async preflight(alias: string): Promise<SshPreflight> {
		validateSshAlias(alias);
		if (this.connection || this.status.state === "connecting" || this.status.state === "checking")
			throw new Error("Disconnect or cancel the current connection first");
		this.disconnect();
		const generation = ++this.generation;
		this.installation = undefined;
		const controller = new AbortController();
		this.controller = controller;
		this.update({ ...this.status, state: "checking", alias });
		try {
			const probe = await preflightSsh(alias, controller.signal);
			if (generation !== this.generation || controller.signal.aborted) throw new Error("SSH check cancelled");
			this.update({ ...this.status, state: "disconnected", preflight: probe });
			return probe;
		} catch (error) {
			if (generation === this.generation)
				this.update({
					...this.status,
					state: "error",
					errorKind: error instanceof InvalidSavedConnectionError ? "identity" : sshFailureKind(error),
					error: error instanceof Error ? error.message : String(error),
				});
			throw error;
		}
	}
	async authGuide(environment: EnvironmentRef) {
		const saved = await readSaved();
		if (
			!saved ||
			environment.kind !== "ssh" ||
			environment.connectionId !== saved.connectionId ||
			environment.environmentId !== saved.environmentId ||
			!saved.node
		)
			throw new Error(
				"Check and connect this environment before requesting authentication maintenance instructions",
			);
		return {
			...remoteAuthGuide(saved.alias, saved.node, saved.releaseId),
			agentDir: saved.canonicalAgentDir,
		};
	}
	async forget(): Promise<RemoteConnectionStatus> {
		this.disconnect();
		await store().update(() => null);
		return this.update({ state: "disconnected" });
	}
	private controller?: AbortController;
	private connection?: SshRuntimeConnection;
	private detach?: () => void;
	private readonly clientTag = randomUUID();
	private readonly uncertain = new Map<string, UncertainRemoteOperation>();
	private update(patch: Omit<RemoteConnectionStatus, "revision">): RemoteConnectionStatus {
		this.status = {
			...patch,
			instanceId: patch.environment ? (patch.instanceId ?? this.status.instanceId) : undefined,
			revision: this.status.revision + 1,
			operations: [...this.uncertain.values()],
		};
		sendToRenderer(SUBSCRIPTION_TABLE.onRemoteConnectionStatus.channel, this.status);
		return this.status;
	}

	private track(error: RemoteMutationUnknownError, environment: EnvironmentRef): void {
		const reference = error.operation;
		const id = `${reference.instanceId}:${reference.epoch}:${reference.sequence}`;
		this.uncertain.set(id, { id, environment, operation: reference, createdAt: error.createdAt });
		if (this.uncertain.size > 128) {
			const oldest = this.uncertain.keys().next().value;
			if (oldest) this.uncertain.delete(oldest);
		}
		this.update(this.status);
	}
	async checkOperation(id: string): Promise<MutationReceipt> {
		const record = this.uncertain.get(id);
		if (!record) return { state: "unknown" };
		if (
			!this.connection ||
			!this.status.environment ||
			!sameEnvironment(record.environment, this.status.environment)
		)
			throw new Error("Reconnect to the original environment before checking the remote operation");
		const receipt = await this.connection.queryReceipt(record.operation);
		this.uncertain.set(id, { ...record, receipt });
		this.update(this.status);
		return receipt;
	}
	dismissOperation(id: string): void {
		this.uncertain.delete(id);
		this.update(this.status);
	}
	async getStatus(): Promise<RemoteConnectionStatus> {
		if (this.status.revision === 0) {
			let saved: SavedConnection | null;
			try {
				saved = await readSaved();
			} catch (error) {
				return this.update({
					state: "error",
					errorKind: "identity",
					error: error instanceof Error ? error.message : "Invalid saved SSH connection",
				});
			}
			if (saved && this.status.revision === 0)
				this.update({
					state: "disconnected",
					alias: saved.alias,
					environment: { kind: "ssh", connectionId: saved.connectionId, environmentId: saved.environmentId },
				});
		}
		return this.status;
	}
	pauseAutoConnect(): void {
		this.autoConnect = false;
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}
	async stopService(): Promise<RemoteConnectionStatus> {
		this.pauseAutoConnect();
		const target = this.connection;
		if (!target || this.status.state !== "connected")
			throw new Error("Connect before explicitly stopping the service");
		const generation = this.generation;
		this.update({ ...this.status, state: "stopping" });
		try {
			await target.stopService();
			if (generation !== this.generation) return this.status;
			this.disconnect();
			return this.update({ ...this.status, serviceStopped: true });
		} catch (error) {
			if (generation !== this.generation) return this.status;
			this.disconnect();
			this.update({
				...this.status,
				state: "error",
				errorKind: "other",
				error:
					"Remote service stop is unconfirmed; do not start another version until ownership release is verified",
			});
			throw error;
		}
	}
	disconnect(): RemoteConnectionStatus {
		this.pauseAutoConnect();
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.generation += 1;
		this.installation = undefined;
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
	async prepareInstall(alias: string): Promise<RemoteConnectionStatus> {
		await this.connect(alias, false, true);
		return this.status;
	}
	async installAndConnect(token: string): Promise<RemoteConnectionStatus> {
		const plan = this.installation;
		if (
			!plan ||
			plan.token !== token ||
			this.status.installation?.token !== token ||
			this.status.alias !== plan.probe.alias ||
			!this.controller ||
			this.controller.signal.aborted
		)
			throw new Error("Installation confirmation expired; check the target again");
		this.installation = undefined;
		const generation = this.generation,
			signal = this.controller.signal;
		this.update({ ...this.status, state: "connecting", installation: undefined });
		try {
			const artifact = plan.manifest.artifacts[plan.probe.arch as "arm64" | "x64"];
			await this.distribution.install(
				plan.probe,
				plan.archive,
				{
					...artifact,
					releaseId: plan.manifest.releaseId,
					protocol: plan.manifest.protocol,
					arch: plan.probe.arch,
				},
				signal,
			);
			if (generation !== this.generation || signal.aborted) return this.status;
			this.update({ ...this.status, state: "disconnected" });
			return await this.connect(plan.probe.alias);
		} catch (error) {
			if (generation === this.generation)
				this.update({
					...this.status,
					state: "error",
					errorKind: "other",
					error: error instanceof Error ? error.message : String(error),
				});
			throw error;
		}
	}
	async connect(alias: string, automatic = false, forcePrepare = false): Promise<RemoteConnectionStatus> {
		if (automatic && !this.autoConnect) return this.status;
		validateSshAlias(alias);
		if (["connecting", "checking", "stopping"].includes(this.status.state))
			throw new Error("A remote connection is already being established");
		if (this.connection) {
			if (alias === this.status.alias) return this.status;
			throw new Error("Disconnect the existing remote environment first");
		}
		if (!automatic) {
			this.autoConnect = true;
			this.retryCount = 0;
			clearTimeout(this.retryTimer);
		}
		const generation = ++this.generation;
		this.installation = undefined;
		const controller = new AbortController();
		this.controller = controller;
		this.update({ state: "connecting", alias, environment: this.status.environment });
		let connection: SshRuntimeConnection | undefined;
		let transportClosed = false;
		try {
			await this.authorize();
			const saved = await readSaved();
			if (generation !== this.generation || controller.signal.aborted) return this.status;
			if (saved && saved.alias !== alias)
				throw new Error("This desktop is already bound to another SSH alias");
			const probe = await preflightSsh(alias, controller.signal);
			checkSshRequirements(probe);
			if (
				saved &&
				(probe.uid !== saved.uid ||
					(probe.agentDir && probe.agentDir !== saved.canonicalAgentDir) ||
					(probe.environmentId && probe.environmentId !== saved.environmentId))
			)
				throw new Error("Remote identity changed: UID or data directory differs");
			if (saved?.target && JSON.stringify(saved.target) !== JSON.stringify(probe.target))
				throw new Error("Remote identity changed: effective SSH hostname, port or user differs");
			if (generation !== this.generation || controller.signal.aborted) return this.status;
			this.update({ ...this.status, state: "connecting", preflight: probe });
			if (forcePrepare || (!probe.installed && probe.serviceState !== "running")) {
				if (automatic) throw new Error("NOT_INSTALLED: Open the connection dialog to confirm installation");
				const manifest = await this.distribution.manifest();
				const artifact = manifest.artifacts[probe.arch as "arm64" | "x64"];
				const archive = await this.distribution.download(artifact, controller.signal);
				if (generation !== this.generation || controller.signal.aborted) return this.status;
				const token = randomUUID();
				this.installation = { token, probe, manifest, archive };
				return this.update({
					...this.status,
					state: "disconnected",
					installation: {
						token,
						releaseId: manifest.releaseId,
						bytes: artifact.bytes,
						directory: `${probe.home}/.local/share/percho/releases/${manifest.releaseId}`,
					},
				});
			}
			const connectionId = saved?.connectionId ?? randomUUID();
			let environment: Extract<EnvironmentRef, { kind: "ssh" }> | undefined;
			connection = await SshRuntimeConnection.connect(alias, {
				signal: controller.signal,
				clientTag: this.clientTag,
				preflight: probe,
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
						state: this.status.state === "stopping" ? "stopping" : "error",
						alias,
						environment: this.status.environment,
						error: "SSH connection closed",
						errorKind: "network",
						preflight: probe,
					});
					this.scheduleRetry(alias);
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
			await store().update(() => {
				if (generation !== this.generation || controller.signal.aborted || transportClosed)
					throw new Error("Remote connection cancelled");
				return {
					connectionId,
					alias,
					environmentId: info.environmentId,
					uid: info.uid,
					canonicalAgentDir: info.canonicalAgentDir,
					node: probe.node,
					releaseId: info.releaseId,
					target: probe.target,
				};
			});
			if (generation !== this.generation || controller.signal.aborted || transportClosed)
				throw new Error("Remote connection cancelled");
			environment = { kind: "ssh", connectionId, environmentId: info.environmentId };
			const target = connection;
			this.detach = environmentRouter.attach(environment, {
				invoke: async (method, args) => {
					try {
						return await target.invoke(method, args);
					} catch (error) {
						if (error instanceof RemoteMutationUnknownError) this.track(error, environment as EnvironmentRef);
						throw error;
					}
				},
			});
			this.connection = connection;
			this.retryCount = 0;
			return this.update({
				state: "connected",
				alias,
				environment,
				instanceId: info.instanceId,
				preflight: probe,
			});
		} catch (error) {
			connection?.disconnect();
			if (generation !== this.generation) return this.status;
			this.update({
				state: "error",
				alias,
				environment: this.status.environment,
				error: error instanceof Error ? error.message : String(error),
				errorKind: error instanceof InvalidSavedConnectionError ? "identity" : sshFailureKind(error),
				preflight: this.status.preflight,
			});
			this.scheduleRetry(
				alias,
				error instanceof Error && error.message.includes(`already controlled by ${this.clientTag}`),
			);
			throw error;
		}
	}
}

export const remoteConnectionManager = new RemoteConnectionManager();
