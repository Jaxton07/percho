import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonStore, JsonStoreCorruptedError, validateSshAlias } from "@percho/backend";
import type { RemoteCatalogSnapshot, RemoteConnectionBinding, RemoteConnectionRecord } from "@percho/shared";
import { app } from "electron";

type DiskCatalog = {
	version: 2;
	catalogRevision: number;
	records: RemoteConnectionRecord[];
	lastSuccessfulConnectionId: string | null;
};
type ErrorKind = NonNullable<RemoteCatalogSnapshot["errorKind"]>;
class CatalogError extends Error {
	constructor(
		readonly kind: ErrorKind,
		message: string,
	) {
		super(message);
	}
}
const queues = new Map<string, Promise<void>>();
function enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const next = (queues.get(path) ?? Promise.resolve()).then(operation, operation);
	const done = next.then(
		() => {},
		() => {},
	);
	queues.set(path, done);
	void done.then(() => {
		if (queues.get(path) === done) queues.delete(path);
	});
	return next;
}
const empty = (): DiskCatalog => ({
	version: 2,
	catalogRevision: 0,
	records: [],
	lastSuccessfulConnectionId: null,
});
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function invalid(): never {
	throw new CatalogError("invalid", "Saved SSH connections are invalid");
}
function validateBinding(value: unknown): asserts value is RemoteConnectionBinding {
	if (
		!object(value) ||
		!nonempty(value.environmentId) ||
		!integer(value.uid) ||
		!nonempty(value.canonicalAgentDir) ||
		!value.canonicalAgentDir.startsWith("/") ||
		(value.node !== undefined && (!nonempty(value.node) || !value.node.startsWith("/"))) ||
		(value.releaseId !== undefined && !nonempty(value.releaseId))
	)
		invalid();
	if (
		value.target !== undefined &&
		(!object(value.target) ||
			!nonempty(value.target.hostname) ||
			!nonempty(value.target.user) ||
			!nonempty(value.target.port))
	)
		invalid();
}
function validateRecord(value: unknown): asserts value is RemoteConnectionRecord {
	if (
		!object(value) ||
		!nonempty(value.connectionId) ||
		typeof value.alias !== "string" ||
		!integer(value.revision)
	)
		invalid();
	try {
		validateSshAlias(value.alias);
	} catch {
		invalid();
	}
	if (value.binding !== undefined) validateBinding(value.binding);
}
function parse(value: unknown): { data: DiskCatalog; migrated: boolean } {
	if (value === null) return { data: empty(), migrated: true };
	if (!object(value)) return invalid();
	if ("version" in value) {
		if (!integer(value.version)) invalid();
		if (value.version !== 2) throw new CatalogError("version", "Unsupported SSH connections version");
		if (
			!Array.isArray(value.records) ||
			(value.catalogRevision !== undefined && !integer(value.catalogRevision)) ||
			(value.lastSuccessfulConnectionId !== null && !nonempty(value.lastSuccessfulConnectionId))
		)
			invalid();
		const ids = new Set<string>();
		const aliases = new Set<string>();
		for (const record of value.records) {
			validateRecord(record);
			if (ids.has(record.connectionId) || aliases.has(record.alias)) invalid();
			ids.add(record.connectionId);
			aliases.add(record.alias);
		}
		if (
			value.lastSuccessfulConnectionId !== null &&
			!value.records.some((r) => r.connectionId === value.lastSuccessfulConnectionId && r.binding)
		)
			invalid();
		return {
			data: {
				version: 2,
				catalogRevision: (value.catalogRevision as number | undefined) ?? 0,
				records: value.records,
				lastSuccessfulConnectionId: value.lastSuccessfulConnectionId as string | null,
			},
			migrated: false,
		};
	}
	if (!nonempty(value.connectionId) || typeof value.alias !== "string") invalid();
	const binding = {
		environmentId: value.environmentId,
		uid: value.uid,
		canonicalAgentDir: value.canonicalAgentDir,
		...(value.node !== undefined && { node: value.node }),
		...(value.releaseId !== undefined && { releaseId: value.releaseId }),
		...(value.target !== undefined && { target: value.target }),
	};
	validateBinding(binding);
	const record = { connectionId: value.connectionId, alias: value.alias, revision: 0, binding };
	validateRecord(record);
	return {
		data: {
			version: 2,
			catalogRevision: 0,
			records: [record],
			lastSuccessfulConnectionId: record.connectionId,
		},
		migrated: true,
	};
}

export class RemoteCatalog {
	private readonly path: string;
	private readonly store: JsonStore<unknown>;
	private current?: RemoteCatalogSnapshot;
	private resetProof?: { token: string; hash: string };
	constructor(
		private readonly epoch: string,
		path?: string,
	) {
		this.path = resolve(path ?? join(app.getPath("userData"), "remote-connection.json"));
		this.store = new JsonStore<unknown>({ path: this.path, defaultValue: () => null });
	}
	private publish(data: DiskCatalog): RemoteCatalogSnapshot {
		this.resetProof = undefined;
		this.current = {
			epoch: this.epoch,
			revision: data.catalogRevision,
			records: structuredClone(data.records),
			lastSuccessfulConnectionId: data.lastSuccessfulConnectionId,
		};
		return this.snapshot();
	}
	snapshot(): RemoteCatalogSnapshot {
		if (!this.current) throw new Error("SSH catalog has not been loaded");
		return structuredClone(this.current);
	}
	private async fingerprint(): Promise<string> {
		return createHash("sha256")
			.update(await readFile(this.path))
			.digest("hex");
	}
	async load(): Promise<RemoteCatalogSnapshot> {
		return enqueue(this.path, async () => {
			try {
				const { data, migrated } = parse(await this.store.readStrict());
				if (this.current?.error)
					data.catalogRevision = Math.max(data.catalogRevision, this.current.revision) + 1;
				if (migrated || this.current?.error) await this.store.write(data);
				return this.publish(data);
			} catch (error) {
				let kind: ErrorKind =
					error instanceof JsonStoreCorruptedError
						? "corrupted"
						: error instanceof CatalogError
							? error.kind
							: "io";
				const previousProof = this.resetProof;
				this.resetProof = undefined;
				if (kind === "corrupted" || kind === "invalid") {
					try {
						const raw = await readFile(this.path);
						let observed: ErrorKind | undefined;
						try {
							let value: unknown;
							try {
								value = JSON.parse(raw.toString("utf8"));
							} catch {
								throw new CatalogError("corrupted", "Saved SSH connections are corrupted");
							}
							parse(value);
						} catch (cause) {
							observed = cause instanceof CatalogError ? cause.kind : "io";
						}
						if (observed !== kind) throw new Error("SSH catalog changed during load");
						const hash = createHash("sha256").update(raw).digest("hex");
						this.resetProof = {
							token: previousProof?.hash === hash ? previousProof.token : randomUUID(),
							hash,
						};
					} catch {
						kind = "io";
					}
				}
				this.current = {
					epoch: this.epoch,
					revision:
						(this.current?.revision ?? 0) +
						(this.current?.error && previousProof?.hash !== this.resetProof?.hash ? 1 : 0),
					records: [],
					lastSuccessfulConnectionId: null,
					error:
						kind === "io"
							? "Unable to read or save SSH connections"
							: error instanceof Error
								? error.message
								: "Unable to read SSH connections",
					errorKind: kind,
					...(this.resetProof && { resetToken: this.resetProof.token }),
				};
				return this.snapshot();
			}
		});
	}
	record(connectionId: string): RemoteConnectionRecord {
		const snapshot = this.snapshot();
		if (snapshot.errorKind) throw new Error(snapshot.error);
		const record = snapshot.records.find((item) => item.connectionId === connectionId);
		if (!record) throw new Error("SSH connection not found");
		return record;
	}
	private async change<T>(
		fn: (data: DiskCatalog) => T,
	): Promise<{ result: T; catalog: RemoteCatalogSnapshot }> {
		return enqueue(this.path, async () => {
			const current = this.snapshot();
			if (current.errorKind) throw new Error(current.error);
			const { data, migrated } = parse(await this.store.readStrict());
			if (migrated) throw new Error("SSH catalog changed; reload required");
			const before = JSON.stringify(data);
			const result = fn(data);
			if (JSON.stringify(data) === before) return { result, catalog: this.publish(data) };
			data.catalogRevision = Math.max(data.catalogRevision, current.revision) + 1;
			await this.store.write(data);
			return { result, catalog: this.publish(data) };
		});
	}
	async add(
		alias: string,
		expectedRevision: number,
	): Promise<{ connectionId: string; catalog: RemoteCatalogSnapshot }> {
		alias = validateSshAlias(alias.trim());
		const { result, catalog } = await this.change((data) => {
			if (expectedRevision !== this.snapshot().revision || expectedRevision !== data.catalogRevision)
				throw new Error("Stale SSH catalog revision");
			if (data.records.some((record) => record.alias === alias)) throw new Error("SSH alias already exists");
			const connectionId = randomUUID();
			data.records.push({ connectionId, alias, revision: 0 });
			return connectionId;
		});
		return { connectionId: result, catalog };
	}
	async bind(id: string, binding: RemoteConnectionBinding): Promise<RemoteCatalogSnapshot> {
		validateBinding(binding);
		const { catalog } = await this.change((data) => {
			const record = data.records.find((item) => item.connectionId === id);
			if (!record) throw new Error("SSH connection not found");
			if (
				JSON.stringify(record.binding) === JSON.stringify(binding) &&
				data.lastSuccessfulConnectionId === id
			)
				return;
			record.binding = structuredClone(binding);
			record.revision++;
			data.lastSuccessfulConnectionId = id;
		});
		return catalog;
	}
	async remove(id: string, recordRevision: number): Promise<RemoteCatalogSnapshot> {
		const { catalog } = await this.change((data) => {
			const index = data.records.findIndex((item) => item.connectionId === id);
			if (index < 0 || data.records[index]?.revision !== recordRevision)
				throw new Error("Stale or missing SSH connection");
			data.records.splice(index, 1);
			if (data.lastSuccessfulConnectionId === id) data.lastSuccessfulConnectionId = null;
		});
		return catalog;
	}
	async reset(token: string): Promise<RemoteCatalogSnapshot> {
		return enqueue(this.path, async () => {
			const proof = this.resetProof;
			if (!proof || proof.token !== token || (await this.fingerprint()) !== proof.hash)
				throw new Error("SSH catalog reset confirmation is stale");
			const data = empty();
			data.catalogRevision = (this.current?.revision ?? 0) + 1;
			await this.store.write(data);
			return this.publish(data);
		});
	}
}
