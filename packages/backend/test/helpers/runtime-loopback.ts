import { Duplex, PassThrough } from "node:stream";
import { executionContract, REMOTE_PROTOCOL_VERSION, type RuntimeRequest } from "@percho/shared";
import { createExecutionHandlers } from "../../src/execution-handlers";
import type { PiBackend } from "../../src/pi-backend";
import { RuntimeClient } from "../../src/runtime/client";
import { RuntimeWriter, readRuntimeFrames } from "../../src/runtime/frames";

/** 模拟attach桥；真实生产handler/分块编解码，不是SSH/Linux宿主证据。 */
export function runtimeLoopback(backend: PiBackend, directory: string) {
	const handlers = createExecutionHandlers(backend, { allowInteractiveAuth: false });
	const requests = new PassThrough(),
		responses = new PassThrough(),
		writer = new RuntimeWriter(responses);
	let chunks = 0;
	responses.on("data", (buffer: Buffer) => {
		chunks += buffer.toString().match(/"type":"chunk"/g)?.length ?? 0;
	});
	const events: Array<{ method: string; payload: unknown }> = [];
	const client = RuntimeClient.fromStream(
		Duplex.from({ readable: responses, writable: requests }),
		(method, payload) => events.push({ method, payload }),
	);
	const reader = readRuntimeFrames(
		(value) => {
			const request = value as RuntimeRequest;
			void (async () => {
				if (request.type === "attach") {
					writer.write({
						type: "result",
						id: request.id,
						result: {
							info: {
								...executionContract(),
								protocol: REMOTE_PROTOCOL_VERSION,
								runtimeVersion: "synthetic",
								environmentId: "remote",
								instanceId: "loopback",
								canonicalAgentDir: directory,
								uid: 1,
								pid: 1,
								startedAt: 1,
							},
							epoch: 1,
						},
					});
					return;
				}
				if (request.type !== "invoke") return;
				try {
					writer.write({
						type: "result",
						id: request.id,
						result: await handlers[request.method](request.args),
					});
				} catch (error) {
					writer.write({
						type: "result",
						id: request.id,
						code: "READ_FAILED",
						error: error instanceof Error ? error.message : "Read failed",
					});
				}
			})();
		},
		() => client.close(),
	);
	requests.on("data", reader);
	const off = backend.onEvent((sessionId, event, sequence) =>
		writer.write(
			{
				type: "event",
				method: "onEvent",
				payload: { sessionId, event, sequence, instanceId: "loopback", epoch: 1 },
			},
			true,
		),
	);
	return {
		client,
		events,
		chunkCount: () => chunks,
		close: () => {
			off();
			client.close();
			writer.dispose();
			requests.destroy();
			responses.destroy();
		},
	};
}
