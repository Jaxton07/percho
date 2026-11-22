import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	checkSshRequirements,
	installSshRuntime,
	preflightSsh,
	RemoteMutationUnknownError,
	remoteAuthGuide,
	SshRuntimeConnection,
	sshFailureKind,
} from "@percho/backend";
import {
	type EnvironmentRef,
	type LoadedSessionSummary,
	type MutationReceipt,
	type RemoteAddCommand,
	type RemoteCatalogSnapshot,
	type RemoteConnectionRecord,
	type RemoteConnectionStatus,
	type RemoteRecordCommand,
	type RemoteRemoveCommand,
	type RemoteSwitchCommand,
	type RemoteTokenCommand,
	type SessionEventEnvelope,
	type SshPreflight,
	SUBSCRIPTION_TABLE,
	type SubscriptionPayload,
	sameEnvironment,
	type UncertainRemoteOperation,
} from "@percho/shared";
import { app } from "electron";
import { environmentRouter } from "./environment-router";
import { sendToRenderer } from "./ipc/send";
import { RemoteCatalog } from "./remote-catalog";
import {
	downloadRuntimeArtifact,
	type RuntimeManifest,
	readRuntimeManifest,
} from "./remote-runtime-download";
import { observeTaskNotification, taskNotificationObserver } from "./task-notifications";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const identityError = (error: unknown) => /identity|saved SSH|catalog|target changed/i.test(message(error));
const targetEquals = (a: SshPreflight["target"], b: SshPreflight["target"]) =>
	a.hostname === b.hostname && a.user === b.user && a.port === b.port;
const environmentFor = (
	record: RemoteConnectionRecord,
): Extract<EnvironmentRef, { kind: "ssh" }> | undefined =>
	record.binding
		? { kind: "ssh", connectionId: record.connectionId, environmentId: record.binding.environmentId }
		: undefined;

type Installation = {
	token: string;
	recordId: string;
	generation: number;
	probe: SshPreflight;
	manifest: RuntimeManifest;
	archive: string;
};

/** One desktop-owned intent. Network work is cancellable; only short catalog commits are serialized. */
export class RemoteConnectionManager {
	private readonly epoch = randomUUID();
	private readonly catalog = new RemoteCatalog(this.epoch);
	private loaded?: Promise<void>;
	private status: RemoteConnectionStatus = {
		revision: 0,
		state: "disconnected",
		epoch: this.epoch,
		generation: 0,
	};
	private generation = 0;
	private mutations: Promise<void> = Promise.resolve();
	private installation?: Installation;
	private approvedTarget?: { recordId: string; generation: number; target: SshPreflight["target"] };
	private controller?: AbortController;
	private connection?: SshRuntimeConnection;
	private detach?: () => void;
	private autoConnect = true;
	private retryCount = 0;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private readonly clientTag = randomUUID();
	private authorize: () => Promise<void> = async () => {};
	private readonly uncertain = new Map<string, UncertainRemoteOperation>();
	private operationsTruncated = false;
	private readonly unconfirmedStops = new Set<string>();
	private maintenanceKey(record: RemoteConnectionRecord): string {
		const b = record.binding;
		return JSON.stringify([b?.environmentId, b?.uid, b?.canonicalAgentDir, b?.target]);
	}

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

	private serial<T>(action: () => T | Promise<T>): Promise<T> {
		const result = this.mutations.then(action);
		this.mutations = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	private publishCatalog(catalog: RemoteCatalogSnapshot): RemoteCatalogSnapshot {
		sendToRenderer(SUBSCRIPTION_TABLE.onRemoteCatalog.channel, catalog);
		return catalog;
	}
	private ensure(): Promise<void> {
		this.loaded ??= this.catalog.load().then((catalog) => {
			this.publishCatalog(catalog);
			if (catalog.error) {
				this.update({ state: "error", error: catalog.error, errorKind: "identity" });
				return;
			}
			const record = catalog.records.find((item) => item.connectionId === catalog.lastSuccessfulConnectionId);
			this.update({
				state: "disconnected",
				connectionId: record?.connectionId,
				alias: record?.alias,
				environment: record && environmentFor(record),
			});
		});
		return this.loaded;
	}
	private update(patch: Omit<RemoteConnectionStatus, "revision">): RemoteConnectionStatus {
		const record = patch.connectionId
			? this.catalog.snapshot().records.find((r) => r.connectionId === patch.connectionId)
			: undefined;
		this.status = {
			stopUnconfirmed: !!record && this.unconfirmedStops.has(this.maintenanceKey(record)),
			...patch,
			epoch: this.epoch,
			generation: this.generation,
			revision: this.status.revision + 1,
			operations: [...this.uncertain.values()],
			operationsTruncated: this.operationsTruncated,
		};
		sendToRenderer(SUBSCRIPTION_TABLE.onRemoteConnectionStatus.channel, this.status);
		return this.status;
	}
	private assert(command: RemoteRecordCommand): RemoteConnectionRecord {
		if (command.epoch !== this.epoch || command.generation !== this.generation)
			throw new Error("SSH connection changed; refresh before trying again");
		return this.catalog.record(command.connectionId);
	}
	private busy(): boolean {
		return (
			["checking", "connecting", "reconnecting", "stopping"].includes(this.status.state) ||
			!!this.status.installation ||
			!!this.status.targetConfirmation
		);
	}
	private assertAvailable(): void {
		if (this.busy() || this.connection)
			throw new Error(
				"A remote connection is already being established or active; cancel or disconnect first",
			);
	}
	private clearTransport(): void {
		if (this.status.environment) taskNotificationObserver.detach(this.status.environment);
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.installation = undefined;
		this.approvedTarget = undefined;
		this.controller?.abort();
		this.controller = undefined;
		this.detach?.();
		this.detach = undefined;
		const connection = this.connection;
		this.connection = undefined;
		connection?.disconnect();
	}
	private reserve(record: RemoteConnectionRecord, state: "checking" | "connecting"): number {
		this.clearTransport();
		this.generation++;
		this.controller = new AbortController();
		this.update({
			state,
			connectionId: record.connectionId,
			alias: record.alias,
			environment: environmentFor(record),
		});
		return this.generation;
	}
	private command(): RemoteRecordCommand {
		if (!this.status.connectionId) throw new Error("No SSH connection selected");
		return { epoch: this.epoch, generation: this.generation, connectionId: this.status.connectionId };
	}
	private current(generation: number): boolean {
		return generation === this.generation && !!this.controller && !this.controller.signal.aborted;
	}
	async getStatus(): Promise<RemoteConnectionStatus> {
		await this.ensure();
		return this.status;
	}
	async getCatalog(): Promise<RemoteCatalogSnapshot> {
		await this.ensure();
		if (!this.catalog.snapshot().error) return this.catalog.snapshot();
		return this.serial(async () => {
			const snapshot = await this.catalog.load();
			this.publishCatalog(snapshot);
			if (!snapshot.error) this.update({ state: "disconnected" });
			return snapshot;
		});
	}
	async add(command: RemoteAddCommand): Promise<{ connectionId: string; catalog: RemoteCatalogSnapshot }> {
		await this.ensure();
		return this.serial(async () => {
			if (command.epoch !== this.epoch || command.generation !== this.generation)
				throw new Error("SSH connection changed; refresh before adding");
			if (this.busy()) throw new Error("Finish or cancel the current SSH operation first");
			const result = await this.catalog.add(command.alias, command.catalogRevision);
			this.publishCatalog(result.catalog);
			return result;
		});
	}
	async resetCatalog(command: { epoch: string; token: string }): Promise<RemoteCatalogSnapshot> {
		await this.ensure();
		return this.serial(async () => {
			if (command.epoch !== this.epoch || this.busy() || this.connection)
				throw new Error("SSH reset confirmation expired");
			const catalog = await this.catalog.reset(command.token);
			this.generation++;
			this.update({ state: "disconnected" });
			return this.publishCatalog(catalog);
		});
	}
	async forget(command: RemoteRemoveCommand): Promise<RemoteCatalogSnapshot> {
		await this.ensure();
		return this.serial(async () => {
			const record = this.assert(command);
			if (record.revision !== command.recordRevision) throw new Error("SSH removal confirmation expired");
			if (this.status.state === "stopping") throw new Error("Remote service stop is still in progress");
			const active = this.status.connectionId === record.connectionId;
			if (active && this.busy()) throw new Error("Cancel the SSH operation before removing this connection");
			if (active) this.release();
			const catalog = await this.catalog.remove(record.connectionId, record.revision);
			if (active) this.update({ state: "disconnected" });
			return this.publishCatalog(catalog);
		});
	}
	private release(): RemoteConnectionStatus {
		this.autoConnect = false;
		this.generation++;
		this.clearTransport();
		return this.update({
			state: "disconnected",
			connectionId: this.status.connectionId,
			alias: this.status.alias,
			environment: this.status.environment,
			stopUnconfirmed: this.status.stopUnconfirmed,
		});
	}
	async disconnect(command: RemoteRecordCommand): Promise<RemoteConnectionStatus> {
		await this.ensure();
		return this.serial(() => {
			this.assert(command);
			if (command.connectionId !== this.status.connectionId)
				throw new Error("This SSH connection is not active");
			if (this.status.state === "stopping") throw new Error("Remote service stop is still in progress");
			return this.release();
		});
	}
	/** Application teardown only; no public IPC path may bypass observed target checks. */
	async shutdown(): Promise<void> {
		await this.serial(() => {
			this.release();
		});
	}
	async preflight(command: RemoteRecordCommand): Promise<SshPreflight> {
		await this.ensure();
		const { record, generation, signal } = await this.serial(() => {
			const record = this.assert(command);
			this.assertAvailable();
			const generation = this.reserve(record, "checking");
			return { record, generation, signal: this.controller!.signal };
		});
		try {
			await this.authorize();
			if (!this.current(generation)) throw new Error("SSH check cancelled");
			const probe = await preflightSsh(record.alias, signal);
			if (!this.current(generation)) throw new Error("SSH check cancelled");
			this.checkIdentity(record, probe);
			this.controller = undefined;
			const maintenanceKey = this.maintenanceKey(record);
			if (probe.serviceState === "stopped") this.unconfirmedStops.delete(maintenanceKey);
			this.update({
				...this.status,
				state: "disconnected",
				preflight: probe,
				stopUnconfirmed: this.unconfirmedStops.has(maintenanceKey),
			});
			return probe;
		} catch (error) {
			this.fail(error, generation);
			throw error;
		}
	}
	async connect(command: RemoteRecordCommand): Promise<RemoteConnectionStatus> {
		return this.start(command, false, false);
	}
	async prepareInstall(command: RemoteRecordCommand): Promise<RemoteConnectionStatus> {
		return this.start(command, false, true);
	}
	async reconnect(command: RemoteRecordCommand): Promise<RemoteConnectionStatus> {
		await this.ensure();
		const { record, generation } = await this.serial(() => {
			const record = this.assert(command);
			if (this.status.state !== "connected" || this.status.connectionId !== record.connectionId)
				throw new Error("Connect before reconnecting this server");
			this.release();
			this.autoConnect = true;
			this.retryCount = 0;
			return { record, generation: this.reserve(record, "connecting") };
		});
		return this.run(record, generation, false, false);
	}
	async switchConnection(command: RemoteSwitchCommand): Promise<RemoteConnectionStatus> {
		await this.ensure();
		const { record, generation } = await this.serial(() => {
			const record = this.assert(command);
			if (
				!this.connection ||
				this.status.state !== "connected" ||
				this.status.connectionId !== command.currentConnectionId
			)
				throw new Error("SSH switch confirmation expired");
			if (command.currentConnectionId === command.connectionId)
				throw new Error("SSH target is already connected");
			this.release();
			this.autoConnect = true;
			this.retryCount = 0;
			return { record, generation: this.reserve(record, "connecting") };
		});
		return this.run(record, generation, false, false);
	}
	private async start(
		command: RemoteRecordCommand,
		automatic: boolean,
		forcePrepare: boolean,
	): Promise<RemoteConnectionStatus> {
		await this.ensure();
		const { record, generation } = await this.serial(() => {
			const record = this.assert(command);
			if (
				automatic &&
				(!this.autoConnect || (this.status.state !== "reconnecting" && this.status.state !== "disconnected"))
			)
				throw new Error("SSH automatic connection cancelled");
			if (automatic && this.status.state === "reconnecting")
				this.update({ ...this.status, state: "disconnected" });
			this.assertAvailable();
			if (!automatic) {
				this.autoConnect = true;
				this.retryCount = 0;
			}
			return { record, generation: this.reserve(record, "connecting") };
		});
		return this.run(record, generation, automatic, forcePrepare);
	}
	private checkIdentity(record: RemoteConnectionRecord, probe: SshPreflight): void {
		const bound = record.binding;
		if (!bound) return;
		if (
			probe.uid !== bound.uid ||
			probe.agentDir !== bound.canonicalAgentDir ||
			probe.environmentId !== bound.environmentId
		)
			throw new Error("Remote identity changed: UID or data directory differs");
		if (bound.target && !targetEquals(bound.target, probe.target))
			throw new Error("Remote identity changed: effective SSH hostname, port or user differs");
		if (
			this.approvedTarget &&
			(this.approvedTarget.recordId !== record.connectionId ||
				this.approvedTarget.generation !== this.generation ||
				!targetEquals(this.approvedTarget.target, probe.target))
		)
			throw new Error("Remote target changed after confirmation");
	}
	async confirmTarget(command: RemoteTokenCommand): Promise<RemoteConnectionStatus> {
		await this.ensure();
		const record = this.assert(command);
		const pending = this.status.targetConfirmation;
		if (
			!pending ||
			pending.token !== command.token ||
			this.status.connectionId !== record.connectionId ||
			!this.current(command.generation)
		)
			throw new Error("SSH target confirmation expired");
		this.approvedTarget = {
			recordId: record.connectionId,
			generation: command.generation,
			target: pending.target,
		};
		this.update({ ...this.status, state: "connecting", targetConfirmation: undefined });
		return this.run(record, command.generation, false, false);
	}
	async installAndConnect(command: RemoteTokenCommand): Promise<RemoteConnectionStatus> {
		await this.ensure();
		this.assert(command);
		const plan = this.installation;
		if (
			!plan ||
			plan.token !== command.token ||
			plan.recordId !== command.connectionId ||
			plan.generation !== command.generation ||
			this.status.installation?.token !== command.token ||
			!this.current(command.generation)
		)
			throw new Error("Installation confirmation expired; check the target again");
		this.installation = undefined;
		this.update({ ...this.status, state: "connecting", phase: "installing", installation: undefined });
		try {
			await this.authorize();
			if (!this.current(command.generation)) return this.status;
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
				this.controller!.signal,
			);
			if (!this.current(command.generation)) return this.status;
			this.update({ ...this.status, state: "connecting", phase: undefined });
			return await this.run(this.catalog.record(command.connectionId), command.generation, false, false);
		} catch (error) {
			this.fail(error, command.generation);
			throw error;
		}
	}
	private async run(
		record: RemoteConnectionRecord,
		generation: number,
		automatic: boolean,
		forcePrepare: boolean,
	): Promise<RemoteConnectionStatus> {
		let connection: SshRuntimeConnection | undefined;
		let environment: EnvironmentRef | undefined;
		let closed = false;
		const signal = this.controller!.signal;
		try {
			await this.authorize();
			if (!this.current(generation)) return this.status;
			const probe = await preflightSsh(record.alias, signal);
			if (!this.current(generation)) return this.status;
			checkSshRequirements(probe);
			this.checkIdentity(record, probe);
			const maintenanceKey = this.maintenanceKey(record);
			if (probe.serviceState === "stopped") this.unconfirmedStops.delete(maintenanceKey);
			this.update({
				...this.status,
				preflight: probe,
				stopUnconfirmed: this.unconfirmedStops.has(maintenanceKey),
			});
			if (record.binding && !record.binding.target && !this.approvedTarget) {
				if (automatic) throw new Error("Saved SSH target requires manual identity confirmation");
				return this.update({
					...this.status,
					state: "disconnected",
					targetConfirmation: { token: randomUUID(), target: probe.target },
				});
			}
			if (forcePrepare || (!probe.installed && probe.serviceState !== "running")) {
				if (automatic) throw new Error("NOT_INSTALLED: Open the connection dialog to confirm installation");
				if (probe.serviceState && probe.serviceState !== "stopped")
					throw new Error(
						"Explicitly stop the remote service and verify ownership release before installation",
					);
				this.update({ ...this.status, phase: "preparing" });
				const manifest = await this.distribution.manifest();
				if (!this.current(generation)) return this.status;
				const artifact = manifest.artifacts[probe.arch as "arm64" | "x64"];
				const archive = await this.distribution.download(artifact, signal);
				if (!this.current(generation)) return this.status;
				const token = randomUUID();
				this.installation = { token, recordId: record.connectionId, generation, probe, manifest, archive };
				return this.update({
					...this.status,
					state: "disconnected",
					phase: undefined,
					installation: {
						token,
						releaseId: manifest.releaseId,
						bytes: artifact.bytes,
						directory: `${probe.home}/.percho/releases/${manifest.releaseId}`,
					},
				});
			}
			connection = await SshRuntimeConnection.connect(record.alias, {
				signal,
				clientTag: this.clientTag,
				preflight: probe,
				onEvent: (method, payload) => {
					if (!environment || !this.current(generation) || this.status.state !== "connected") return;
					if (method === "onEvent") {
						const source = environment,
							target = connection;
						observeTaskNotification(source, payload as SessionEventEnvelope, async () => {
							if (!this.current(generation)) return undefined;
							const summaries = (await target?.invoke("getLoadedSessions", undefined)) as
								| LoadedSessionSummary[]
								| undefined;
							if (!this.current(generation)) return undefined;
							return summaries?.find(
								(item) => item.meta.sessionId === (payload as SessionEventEnvelope).sessionId,
							)?.meta;
						});
					}
					const definition = SUBSCRIPTION_TABLE[method as keyof typeof SUBSCRIPTION_TABLE];
					if (definition?.scope === "environment")
						sendToRenderer(
							definition.channel,
							payload as SubscriptionPayload<typeof definition.channel>,
							environment,
							{ epoch: this.epoch, generation },
						);
				},
				onClose: () => {
					closed = true;
					if (generation !== this.generation || !this.connection || this.status.state === "stopping") return;
					this.detach?.();
					this.detach = undefined;
					this.connection = undefined;
					if (environment) taskNotificationObserver.detach(environment);
					this.update({
						...this.status,
						state: "error",
						error: "SSH connection closed",
						errorKind: "network",
					});
					this.scheduleRetry();
				},
			});
			const info = connection.info;
			if (
				info.uid !== probe.uid ||
				info.canonicalAgentDir !== probe.agentDir ||
				(probe.environmentId && info.environmentId !== probe.environmentId) ||
				(record.binding &&
					(record.binding.environmentId !== info.environmentId ||
						record.binding.uid !== info.uid ||
						record.binding.canonicalAgentDir !== info.canonicalAgentDir))
			)
				throw new Error("Remote identity changed; existing projects cannot be rebound automatically");
			const target = connection;
			await this.serial(async () => {
				if (!this.current(generation) || closed) throw new Error("Remote connection cancelled");
				const catalog = await this.catalog.bind(record.connectionId, {
					environmentId: info.environmentId,
					uid: info.uid,
					canonicalAgentDir: info.canonicalAgentDir,
					node: probe.node,
					releaseId: info.releaseId,
					target: probe.target,
				});
				this.publishCatalog(catalog);
				if (!this.current(generation) || closed) throw new Error("Remote connection cancelled");
				environment = { kind: "ssh", connectionId: record.connectionId, environmentId: info.environmentId };
				this.detach = environmentRouter.attach(environment, {
					invoke: async (method, args) => {
						if (!this.current(generation)) throw new Error("Remote connection changed");
						try {
							const result = await target.invoke(method, args);
							if (!this.current(generation)) throw new Error("Remote connection changed");
							if (environment && method === "deleteSession")
								taskNotificationObserver.delete(environment, (args as { sessionId: string }).sessionId);
							if (environment && method === "closeSession" && (result as { closed: boolean }).closed)
								taskNotificationObserver.unload(environment, (args as { sessionId: string }).sessionId);
							return result;
						} catch (error) {
							if (error instanceof RemoteMutationUnknownError && environment) this.track(error, environment);
							throw error;
						}
					},
				});
				this.connection = target;
				this.retryCount = 0;
				this.update({
					state: "connected",
					connectionId: record.connectionId,
					alias: record.alias,
					environment,
					instanceId: info.instanceId,
					preflight: probe,
				});
			});
			return this.status;
		} catch (error) {
			connection?.disconnect();
			if (generation !== this.generation) return this.status;
			this.fail(error, generation);
			this.scheduleRetry(message(error).includes(`already controlled by ${this.clientTag}`));
			throw error;
		}
	}
	private fail(error: unknown, generation: number): void {
		if (generation !== this.generation) return;
		this.installation = undefined;
		this.update({
			...this.status,
			state: "error",
			phase: undefined,
			installation: undefined,
			targetConfirmation: undefined,
			error: message(error),
			errorKind: identityError(error) ? "identity" : sshFailureKind(error),
		});
	}
	private scheduleRetry(ownBusy = false): void {
		if (!this.autoConnect || this.retryCount >= 5 || (!ownBusy && this.status.errorKind !== "network"))
			return;
		const delay = ownBusy ? 22_000 : Math.min(1000 * 2 ** this.retryCount, 16_000);
		this.retryCount++;
		const command = this.command();
		this.update({ ...this.status, state: "reconnecting", retryAt: Date.now() + delay });
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.autoConnect && command.generation === this.generation)
				void this.start(command, true, false).catch(() => {});
		}, delay);
	}
	startAutoConnect(authorize: () => Promise<void>): void {
		this.authorize = authorize;
		void this.ensure().then(() => {
			const snapshot = this.catalog.snapshot();
			const record = snapshot.records.find(
				(item) => item.connectionId === snapshot.lastSuccessfulConnectionId,
			);
			if (!snapshot.error && this.autoConnect && !this.busy() && !this.connection && record?.binding?.target)
				void this.start(
					{ epoch: this.epoch, generation: this.generation, connectionId: record.connectionId },
					true,
					false,
				).catch(() => {});
		});
	}
	async stopService(command: RemoteRecordCommand): Promise<RemoteConnectionStatus> {
		await this.ensure();
		const { target, generation } = await this.serial(() => {
			this.assert(command);
			if (
				command.connectionId !== this.status.connectionId ||
				!this.connection ||
				this.status.state !== "connected"
			)
				throw new Error("Connect before explicitly stopping the service");
			this.autoConnect = false;
			const target = this.connection;
			this.update({ ...this.status, state: "stopping" });
			return { target, generation: this.generation };
		});
		try {
			await target.stopService();
			return await this.serial(() => {
				if (generation !== this.generation) return this.status;
				this.unconfirmedStops.delete(this.maintenanceKey(this.catalog.record(command.connectionId)));
				this.release();
				return this.update({ ...this.status, serviceStopped: true, stopUnconfirmed: false });
			});
		} catch (error) {
			await this.serial(() => {
				if (generation !== this.generation) return;
				this.unconfirmedStops.add(this.maintenanceKey(this.catalog.record(command.connectionId)));
				this.release();
				this.update({
					...this.status,
					state: "error",
					stopUnconfirmed: true,
					errorKind: "other",
					error:
						"Remote service stop is unconfirmed; verify ownership release before installing or starting another version",
				});
			});
			throw error;
		}
	}
	async authGuide(environment: EnvironmentRef) {
		await this.ensure();
		const record = this.catalog
			.snapshot()
			.records.find(
				(item) =>
					item.connectionId === (environment.kind === "ssh" ? environment.connectionId : "") &&
					item.binding?.environmentId === (environment.kind === "ssh" ? environment.environmentId : ""),
			);
		if (!record?.binding?.node)
			throw new Error(
				"Check and connect this environment before requesting authentication maintenance instructions",
			);
		return {
			...remoteAuthGuide(record.alias, record.binding.node, record.binding.releaseId),
			agentDir: record.binding.canonicalAgentDir,
		};
	}
	private track(error: RemoteMutationUnknownError, environment: EnvironmentRef): void {
		const reference = error.operation;
		const id = `${reference.instanceId}:${reference.epoch}:${reference.sequence}`;
		this.uncertain.set(id, { id, environment, operation: reference, createdAt: error.createdAt });
		if (this.uncertain.size > 128) {
			const oldest = this.uncertain.keys().next().value;
			if (oldest) this.uncertain.delete(oldest);
			this.operationsTruncated = true;
		}
		this.update(this.status);
	}
	async checkOperation(id: string): Promise<MutationReceipt> {
		const record = this.uncertain.get(id),
			target = this.connection,
			generation = this.generation;
		if (!record) return { state: "unknown" };
		if (
			!target ||
			this.status.state !== "connected" ||
			!this.status.environment ||
			!sameEnvironment(record.environment, this.status.environment)
		)
			throw new Error("Reconnect to the original environment before checking the remote operation");
		const receipt = await target.queryReceipt(record.operation);
		this.uncertain.set(id, { ...record, receipt });
		if (generation === this.generation) this.update(this.status);
		return receipt;
	}
	dismissOperation(id: string): void {
		this.uncertain.delete(id);
		this.update(this.status);
	}
}

export const remoteConnectionManager = new RemoteConnectionManager();
