import { createHash } from "node:crypto";
import type { MutationReceipt } from "@percho/shared";

export class MutationProtocolError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
interface ReceiptEntry {
	epoch: number;
	sequence: number;
	digest: string;
	state: "pending" | "succeeded" | "failed" | "rejected";
	result?: string;
	resultOmitted?: true;
	error?: string;
	pending?: Promise<unknown>;
	bytes: number;
}

/** Instance memory only. The current high-water mark is independent of the bounded receipt cache. */
export class MutationBook {
	private epoch = 0;
	private highWater = 0;
	private bytes = 0;
	private readonly entries = new Map<string, ReceiptEntry>();
	constructor(private readonly limits = { entries: 1024, bytes: 4 * 1024 * 1024 }) {}
	beginEpoch(epoch: number): void {
		if (!Number.isSafeInteger(epoch) || epoch <= this.epoch)
			throw new MutationProtocolError("INVALID_EPOCH", "Invalid connection epoch");
		this.epoch = epoch;
		this.highWater = 0;
	}
	private key(epoch: number, sequence: number): string {
		return `${epoch}:${sequence}`;
	}
	private makeRoom(bytes: number, count: number): boolean {
		for (const [key, entry] of this.entries) {
			if (this.entries.size + count <= this.limits.entries && this.bytes + bytes <= this.limits.bytes) break;
			if (entry.state !== "pending") {
				this.entries.delete(key);
				this.bytes -= entry.bytes;
			}
		}
		return this.entries.size + count <= this.limits.entries && this.bytes + bytes <= this.limits.bytes;
	}
	private rememberError(entry: ReceiptEntry, message: string): void {
		const bounded = message.slice(0, 4096);
		const size = Buffer.byteLength(bounded);
		if (this.makeRoom(size, 0)) {
			entry.error = bounded;
			entry.bytes += size;
			this.bytes += size;
		}
	}
	query(epoch: number, sequence: number): MutationReceipt {
		const entry = this.entries.get(this.key(epoch, sequence));
		if (!entry) return { state: "expired" };
		if (entry.state === "pending") return { state: "pending" };
		if (entry.state === "succeeded")
			return {
				state: "succeeded",
				...(entry.result !== undefined ? { result: JSON.parse(entry.result) } : {}),
				...(entry.resultOmitted ? { resultOmitted: true as const } : {}),
			};
		return { state: entry.state, error: entry.error ?? "Remote operation failed" };
	}
	/** Admission and sequence consumption are synchronous, before validation, capacity checks or any await. */
	submit(
		epoch: number,
		sequence: number,
		method: string,
		args: unknown,
		validate: () => void,
		execute: () => unknown,
	): Promise<unknown> {
		if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence < 1)
			throw new MutationProtocolError("INVALID_SEQUENCE", "Invalid mutation identity");
		const digest = createHash("sha256").update(JSON.stringify({ method, args })).digest("hex");
		const key = this.key(epoch, sequence);
		if (sequence <= this.highWater) {
			const previous = this.entries.get(key);
			if (!previous)
				throw new MutationProtocolError(
					"RECEIPT_EXPIRED",
					"Mutation receipt expired; operation must not be replayed",
				);
			if (previous.digest !== digest)
				throw new MutationProtocolError("PAYLOAD_CONFLICT", "Mutation identity has a different payload");
			if (previous.pending) return previous.pending;
			if (previous.state === "succeeded") {
				if (previous.resultOmitted)
					throw new MutationProtocolError(
						"RESULT_UNAVAILABLE",
						"Operation completed; query actual state for its result",
					);
				return Promise.resolve(previous.result === undefined ? undefined : JSON.parse(previous.result));
			}
			return Promise.reject(
				new MutationProtocolError(
					previous.state === "rejected" ? "NOT_EXECUTED" : "OPERATION_FAILED",
					previous.error ?? "Remote operation failed",
				),
			);
		}
		if (sequence !== this.highWater + 1)
			throw new MutationProtocolError("SEQUENCE_GAP", "Mutation sequence is not contiguous");
		this.highWater = sequence;
		const entry: ReceiptEntry = { epoch, sequence, digest, state: "pending", bytes: 256 };
		let validationError: string | undefined;
		try {
			validate();
		} catch (error) {
			validationError = error instanceof Error ? error.message : String(error);
		}
		if (!this.makeRoom(entry.bytes, 1))
			throw new MutationProtocolError(
				"NOT_EXECUTED_CAPACITY",
				"No receipt capacity; operation was not executed",
			);
		this.entries.set(key, entry);
		this.bytes += entry.bytes;
		if (validationError) {
			this.rememberError(entry, validationError);
			entry.state = "rejected";
			return Promise.reject(new MutationProtocolError("NOT_EXECUTED", validationError));
		}
		const pending = Promise.resolve()
			.then(execute)
			.then(
				(result) => {
					let serialized: string | undefined;
					try {
						serialized = JSON.stringify(result);
					} catch {
						entry.state = "succeeded";
						entry.resultOmitted = true;
						throw new MutationProtocolError(
							"RESULT_UNAVAILABLE",
							"Operation completed but its result is unavailable",
						);
					}
					const size = serialized === undefined ? 0 : Buffer.byteLength(serialized);
					if (size <= this.limits.bytes - entry.bytes && this.makeRoom(size, 0)) {
						entry.result = serialized;
						entry.bytes += size;
						this.bytes += size;
					} else entry.resultOmitted = true;
					entry.state = "succeeded";
					return serialized === undefined ? undefined : JSON.parse(serialized);
				},
				(error) => {
					this.rememberError(entry, error instanceof Error ? error.message : String(error));
					entry.state =
						error instanceof MutationProtocolError && error.code === "NOT_EXECUTED" ? "rejected" : "failed";
					throw error;
				},
			)
			.finally(() => {
				entry.pending = undefined;
			});
		entry.pending = pending;
		return pending;
	}
}
