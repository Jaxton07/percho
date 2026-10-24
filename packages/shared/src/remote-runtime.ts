import type { EnvironmentMethod } from "./ipc";

/** Control messages only. Business method identities and payloads remain in ipc-channels.ts. */
export const REMOTE_PROTOCOL_VERSION = 1;
export interface RuntimeInfo {
	protocol: number;
	runtimeVersion: string;
	environmentId: string;
	instanceId: string;
	canonicalAgentDir: string;
	uid: number;
	pid: number;
	startedAt: number;
}
export type RuntimeRequest =
	| { type: "inspect"; id: string }
	| { type: "attach"; id: string; protocol: number; clientTag: string }
	| {
			type: "invoke";
			id: string;
			instanceId: string;
			epoch: number;
			method: EnvironmentMethod;
			args?: unknown;
	  }
	| { type: "pong"; instanceId: string; epoch: number; nonce: string }
	| { type: "stop"; id: string; instanceId: string; epoch: number };
export type RuntimeFrame =
	| { type: "result"; id: string; result?: unknown; error?: string; code?: string }
	| { type: "event"; method: string; payload: unknown }
	| { type: "ping"; nonce: string; instanceId: string; epoch: number };
export interface RuntimeAttachment {
	info: RuntimeInfo;
	epoch: number;
}
