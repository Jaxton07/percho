import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { VERSION as SDK_VERSION } from "@earendil-works/pi-coding-agent";
import {
	CHANNEL_TABLE,
	executionContract,
	REMOTE_PROTOCOL_VERSION,
	type RuntimeFrame,
	type RuntimeInfo,
	type RuntimeRequest,
} from "@percho/shared";
import { createExecutionHandlers } from "../execution-handlers";
import { JsonStore } from "../json-store";
import { PiBackend } from "../pi-backend";
import { bindExecutionEvents } from "./events";
import { RuntimeWriter, readRuntimeFrames } from "./frames";
import { MutationBook, MutationProtocolError } from "./mutations";
import { acquireOwner, ownerIsCurrent, type RuntimePaths } from "./paths";

export async function startRuntimeServer(paths: RuntimePaths) {
	const owner = await acquireOwner(paths);
	if (!owner) throw new Error("RUNTIME_OWNER_BUSY: another service owns this data directory");
	let backend: PiBackend | undefined;
	try {
		// Only the process holding the kernel lifetime lock may remove a stale socket.
		try {
			const stat = await lstat(paths.socket);
			if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Invalid runtime socket path");
			await unlink(paths.socket);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const identity = await new JsonStore<{ environmentId: string } | null>({
			path: `${paths.agent}/environment.json`,
			defaultValue: () => null,
		}).update((value) => value ?? { environmentId: randomUUID() });
		if (!identity || typeof identity.environmentId !== "string" || !identity.environmentId)
			throw new Error("Invalid runtime environment identity");
		backend = new PiBackend();
		await backend.init();
		const runtimeBackend = backend;
		const handlers = createExecutionHandlers(runtimeBackend);
		const info: RuntimeInfo = {
			...executionContract(),
			sdkVersion: SDK_VERSION,
			protocol: REMOTE_PROTOCOL_VERSION,
			runtimeVersion: "0.1.0",
			environmentId: identity.environmentId,
			instanceId: randomUUID(),
			canonicalAgentDir: paths.agent,
			uid: process.getuid?.() ?? -1,
			pid: process.pid,
			startedAt: Date.now(),
		};
		let state: "starting" | "running" | "stopping" | "stopped" = "starting";
		let epoch = 0;
		const mutations = new MutationBook();
		let controller:
			| { socket: Socket; epoch: number; clientTag: string; lastPong: number; nonce?: string }
			| undefined;
		const sockets = new Set<Socket>();
		const writers = new Map<Socket, RuntimeWriter>();
		const write = (socket: Socket, frame: RuntimeFrame) => {
			if (socket.destroyed) return;
			const writer = writers.get(socket);
			if (!writer) return;
			try {
				writer.write(frame, frame.type === "ping");
			} catch (error) {
				if (frame.type === "result" && error instanceof Error && error.message.includes("64 MiB")) {
					try {
						writer.write({ type: "result", id: frame.id, error: error.message, code: "RESULT_UNAVAILABLE" });
					} catch {
						socket.destroy();
					}
				} else socket.destroy();
			}
		};
		const eventsOff = bindExecutionEvents(runtimeBackend, (method, payload) => {
			if (controller) write(controller.socket, { type: "event", method, payload });
		});
		let stopped: Promise<void> | undefined;
		const stop = (): Promise<void> => {
			if (stopped) return stopped;
			state = "stopping";
			stopped = (async () => {
				clearInterval(heartbeat);
				eventsOff();
				runtimeBackend.dispose();
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
				await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
				await owner.close();
				state = "stopped";
			})();
			return stopped;
		};
		const server = createServer((socket) => {
			sockets.add(socket);
			writers.set(socket, new RuntimeWriter(socket));
			socket.once("close", () => {
				sockets.delete(socket);
				writers.delete(socket);
				if (controller?.socket === socket) controller = undefined;
			});
			socket.on("error", () => socket.destroy());
			const result = (id: string, value: unknown) => write(socket, { type: "result", id, result: value });
			const reject = (id: string, error: string, code = "RUNTIME_ERROR") =>
				write(socket, { type: "result", id, error, code });
			const receive = async (value: unknown) => {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					socket.destroy();
					return;
				}
				const request = value as RuntimeRequest;
				if (typeof request.type !== "string") {
					socket.destroy();
					return;
				}
				if (
					request.type !== "pong" &&
					(typeof request.id !== "string" || !request.id || request.id.length > 128)
				) {
					socket.destroy();
					return;
				}
				if (state !== "running") {
					if (request.type !== "pong")
						reject(request.id, "Runtime is not ready", state === "starting" ? "NOT_READY" : "STOPPING");
					return;
				}
				if (request.type === "inspect") {
					result(request.id, {
						...info,
						controller: controller ? { clientTag: controller.clientTag } : null,
					});
					return;
				}
				if (request.type === "attach") {
					if (
						request.protocol !== REMOTE_PROTOCOL_VERSION ||
						typeof request.clientTag !== "string" ||
						!request.clientTag ||
						request.clientTag.length > 128
					) {
						reject(request.id, "Incompatible runtime protocol", "INCOMPATIBLE");
						return;
					}
					if (controller) {
						reject(request.id, `Runtime already controlled by ${controller.clientTag}`, "BUSY");
						return;
					}
					controller = { socket, epoch: ++epoch, clientTag: request.clientTag, lastPong: Date.now() };
					mutations.beginEpoch(epoch);
					result(request.id, { info, epoch });
					return;
				}
				const current = controller;
				if (
					!current ||
					current.socket !== socket ||
					request.instanceId !== info.instanceId ||
					request.epoch !== current.epoch
				) {
					socket.destroy();
					return;
				}
				if (request.type === "pong") {
					if (request.nonce === current.nonce) {
						current.lastPong = Date.now();
						current.nonce = undefined;
					}
					return;
				}

				if (request.type === "receipt") {
					const reference = request.operation;
					if (
						!reference ||
						!Number.isSafeInteger(reference.epoch) ||
						!Number.isSafeInteger(reference.sequence) ||
						reference.epoch < 1 ||
						reference.sequence < 1
					) {
						socket.destroy();
						return;
					}
					result(
						request.id,
						reference.instanceId === info.instanceId
							? mutations.query(reference.epoch, reference.sequence)
							: { state: "unknown" },
					);
					return;
				}
				const authorized = async () => {
					if (
						!(await ownerIsCurrent(paths, owner)) ||
						controller !== current ||
						socket.destroyed ||
						state !== "running"
					)
						throw new MutationProtocolError(
							"NOT_EXECUTED",
							"Connection is no longer authorized; operation was not started",
						);
				};
				if (request.type === "stop") {
					await authorized();
					result(request.id, { accepted: true });
					setImmediate(() => {
						void stop();
					});
					return;
				}
				if (request.type !== "invoke" || typeof request.method !== "string") {
					socket.destroy();
					return;
				}
				const definition = CHANNEL_TABLE[request.method];
				if (definition?.scope !== "environment" || !Object.hasOwn(handlers, request.method)) {
					reject(request.id, "Unknown or desktop-only method");
					return;
				}
				const handler = handlers[request.method] as (args: unknown) => unknown;
				try {
					if (definition.operation === "mutation") {
						// No await before admission: interleaved I/O cannot reorder mutation sequence consumption.
						const completion = mutations.submit(
							current.epoch,
							request.mutationSeq as number,
							request.method,
							request.args,
							() => definition.validate(request.args),
							async () => {
								await authorized();
								return handler(request.args);
							},
						);
						result(request.id, await completion);
					} else {
						if (request.mutationSeq !== undefined) {
							socket.destroy();
							return;
						}
						definition.validate(request.args);
						await authorized();
						result(request.id, await handler(request.args));
					}
				} catch (error) {
					if (
						error instanceof MutationProtocolError &&
						["INVALID_SEQUENCE", "SEQUENCE_GAP"].includes(error.code)
					) {
						socket.destroy();
						return;
					}
					reject(
						request.id,
						error instanceof Error ? error.message : String(error),
						error instanceof MutationProtocolError ? error.code : "RUNTIME_ERROR",
					);
				}
			};
			let inFlight = 0;
			const reader = readRuntimeFrames(
				(frame) => {
					if (++inFlight > 128) {
						socket.destroy();
						return;
					}
					void receive(frame)
						.catch(() => socket.destroy())
						.finally(() => {
							inFlight--;
						});
				},
				() => socket.destroy(),
			);
			socket.on("data", reader);
			socket.once("close", () => reader.dispose());
		});
		const heartbeat = setInterval(() => {
			const current = controller;
			if (current) {
				if (Date.now() - current.lastPong > 20_000) current.socket.destroy();
				else if (!current.nonce) {
					current.nonce = randomUUID();
					write(current.socket, {
						type: "ping",
						nonce: current.nonce,
						instanceId: info.instanceId,
						epoch: current.epoch,
					});
				}
			}
			void ownerIsCurrent(paths, owner).then((valid) => {
				if (!valid) void stop();
			});
		}, 5000);
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(paths.socket, () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			await chmod(paths.socket, 0o600);
			state = "running";
		} catch (error) {
			clearInterval(heartbeat);
			eventsOff();
			for (const socket of sockets) socket.destroy();
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			throw error;
		}
		return { info, stop };
	} catch (error) {
		backend?.dispose();
		await owner.close();
		throw error;
	}
}
