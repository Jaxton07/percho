import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import {
	type EnvironmentMethod,
	REMOTE_PROTOCOL_VERSION,
	type RuntimeAttachment,
	type RuntimeFrame,
	type RuntimeInfo,
	type RuntimeRequest,
} from "@percho/shared";
import { readRuntimeFrames } from "./frames";

export class RuntimeClient {
	private readonly pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private attachment?: RuntimeAttachment;
	private closed = false;
	private constructor(
		private readonly socket: Duplex,
		private readonly onEvent: (method: string, payload: unknown) => void,
	) {
		socket.on(
			"data",
			readRuntimeFrames(
				(value) => this.receive(value as RuntimeFrame),
				(error) => socket.destroy(error),
			),
		);
		const fail = () => {
			this.closed = true;
			for (const request of this.pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error("Runtime connection closed; operation outcome may be unknown"));
			}
			this.pending.clear();
		};
		socket.once("close", fail);
		socket.on("error", fail);
	}
	static fromStream(
		stream: Duplex,
		onEvent: (method: string, payload: unknown) => void = () => {},
	): RuntimeClient {
		return new RuntimeClient(stream, onEvent);
	}
	static async connect(
		socketPath: string,
		onEvent: (method: string, payload: unknown) => void = () => {},
	): Promise<RuntimeClient> {
		const socket = connect(socketPath);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new RuntimeClient(socket, onEvent);
	}
	private send(request: RuntimeRequest): void {
		if (this.closed) throw new Error("Runtime connection is closed");
		this.socket.write(`${JSON.stringify(request)}\n`);
	}
	private receive(frame: RuntimeFrame): void {
		if (frame.type === "ping") {
			const target = this.attachment;
			if (target && frame.instanceId === target.info.instanceId && frame.epoch === target.epoch)
				this.send({ type: "pong", nonce: frame.nonce, instanceId: frame.instanceId, epoch: frame.epoch });
			return;
		}
		if (frame.type === "event") {
			this.onEvent(frame.method, frame.payload);
			return;
		}
		if (frame.type !== "result") {
			this.socket.destroy();
			return;
		}
		const pending = this.pending.get(frame.id);
		if (!pending) return;
		this.pending.delete(frame.id);
		clearTimeout(pending.timer);
		if (frame.error) pending.reject(Object.assign(new Error(frame.error), { code: frame.code }));
		else pending.resolve(frame.result);
	}
	private request(value: Omit<Extract<RuntimeRequest, { id: string }>, "id">): Promise<unknown> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Runtime request timed out; operation outcome may be unknown"));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.send({ ...value, id } as RuntimeRequest);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	async inspect(): Promise<RuntimeInfo> {
		return (await this.request({ type: "inspect" })) as RuntimeInfo;
	}
	async attach(clientTag: string): Promise<RuntimeAttachment> {
		const value = (await this.request({
			type: "attach",
			protocol: REMOTE_PROTOCOL_VERSION,
			clientTag,
		} as Omit<Extract<RuntimeRequest, { type: "attach" }>, "id">)) as RuntimeAttachment;
		if (!value?.info || value.info.protocol !== REMOTE_PROTOCOL_VERSION || !Number.isSafeInteger(value.epoch))
			throw new Error("Invalid runtime handshake");
		this.attachment = value;
		return value;
	}
	invoke(method: EnvironmentMethod, args?: unknown): Promise<unknown> {
		const target = this.requireAttachment();
		return this.request({
			type: "invoke",
			method,
			args,
			instanceId: target.info.instanceId,
			epoch: target.epoch,
		} as Omit<Extract<RuntimeRequest, { type: "invoke" }>, "id">);
	}
	stop(): Promise<unknown> {
		const target = this.requireAttachment();
		return this.request({ type: "stop", instanceId: target.info.instanceId, epoch: target.epoch } as Omit<
			Extract<RuntimeRequest, { type: "stop" }>,
			"id"
		>);
	}
	private requireAttachment(): RuntimeAttachment {
		if (!this.attachment) throw new Error("Runtime client is not attached");
		return this.attachment;
	}
	close(): void {
		this.socket.destroy();
	}
}
