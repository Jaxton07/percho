import type { EnvironmentRef } from "./environment";
import type { EnvironmentMethod } from "./ipc";
import { CHANNEL_TABLE, SUBSCRIPTION_TABLE } from "./ipc-channels";

/** Control messages only. Business method identities and payloads remain in ipc-channels.ts. */
export const REMOTE_PROTOCOL_VERSION = 3;
export const REMOTE_OUTCOME_UNKNOWN = "[PERCHO_REMOTE_OUTCOME_UNKNOWN]";
export const EXECUTION_EVENT_CONTRACT_VERSION = 8;
export const OPTIONAL_EXECUTION_METHODS = ["getSessionNavigation"] as const;
export function executionContract() {
	return {
		eventContract: EXECUTION_EVENT_CONTRACT_VERSION,
		methods: Object.entries(CHANNEL_TABLE)
			.filter(([, definition]) => definition.scope === "environment")
			.map(([method]) => method),
		subscriptions: Object.entries(SUBSCRIPTION_TABLE)
			.filter(([, definition]) => definition.scope === "environment")
			.map(([method]) => method),
	};
}
export interface RuntimeInfo {
	sdkVersion: string;
	eventContract: number;
	methods: string[];
	subscriptions: string[];
	protocol: number;
	runtimeVersion: string;
	releaseId?: string;
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
			mutationSeq?: number;
	  }
	| { type: "receipt"; id: string; instanceId: string; epoch: number; operation: MutationReference }
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

export interface SshAliasDiscovery {
	aliases: string[];
	/** Unreadable/unsupported includes or discovery limits; manual entry remains available. */
	incomplete: boolean;
}

export interface SshPreflight {
	alias: string;
	target: { hostname: string; user: string; port: string };
	uid: number;
	home: string;
	node: string;
	nodeVersion: string;
	platform: string;
	arch: string;
	glibc: string;
	commands: Record<string, boolean>;
	installed: boolean;
	installedReleaseId?: string;
	agentDir?: string;
	environmentId?: string;
	serviceState?: "running" | "stopped" | "unreachable";
	service?: RuntimeInfo;
}
/** Desktop-owned saved records; a bookmark is not an executable environment. */
export interface RemoteConnectionBinding {
	environmentId: string;
	uid: number;
	canonicalAgentDir: string;
	node?: string;
	releaseId?: string;
	target?: SshPreflight["target"];
}
export interface RemoteConnectionRecord {
	connectionId: string;
	alias: string;
	revision: number;
	binding?: RemoteConnectionBinding;
}
export interface RemoteCatalogSnapshot {
	epoch: string;
	revision: number;
	records: RemoteConnectionRecord[];
	lastSuccessfulConnectionId: string | null;
	error?: string;
	errorKind?: "corrupted" | "invalid" | "version" | "io";
	resetToken?: string;
}
export interface RemoteControlContext {
	epoch: string;
	generation: number;
}
export interface RemoteRecordCommand extends RemoteControlContext {
	connectionId: string;
}
export interface RemoteAddCommand extends RemoteControlContext {
	alias: string;
	catalogRevision: number;
}
export interface RemoteRemoveCommand extends RemoteRecordCommand {
	recordRevision: number;
}
export interface RemoteSwitchCommand extends RemoteRecordCommand {
	currentConnectionId: string;
}
export interface RemoteTokenCommand extends RemoteRecordCommand {
	token: string;
}
/** Local desktop delivery metadata, not part of the remote service protocol. */
export interface RemoteEventBoundary {
	epoch: string;
	generation: number;
}
export interface RemoteConnectionStatus {
	revision: number;
	/** Absent only in initial renderer/legacy test snapshots; main always supplies these. */
	epoch?: string;
	generation?: number;
	connectionId?: string;
	phase?: "preparing" | "installing" | "cancelling";
	targetConfirmation?: { token: string; target: SshPreflight["target"] };
	stopUnconfirmed?: boolean;
	operationsTruncated?: boolean;
	state: "disconnected" | "checking" | "connecting" | "stopping" | "reconnecting" | "connected" | "error";
	preflight?: SshPreflight;
	installation?: { token: string; releaseId: string; bytes: number; directory: string };
	errorKind?:
		| "network"
		| "authentication"
		| "hostKey"
		| "identity"
		| "incompatible"
		| "notInstalled"
		| "busy"
		| "requirements"
		| "other";
	retryAt?: number;
	serviceStopped?: boolean;
	instanceId?: string;
	alias?: string;
	environment?: Extract<EnvironmentRef, { kind: "ssh" }>;
	error?: string;
	operations?: UncertainRemoteOperation[];
}

export interface MutationReference {
	instanceId: string;
	epoch: number;
	sequence: number;
}
export type MutationReceipt =
	| { state: "pending" }
	| { state: "succeeded"; result?: unknown; resultOmitted?: true }
	| { state: "failed" | "rejected"; error: string }
	| { state: "expired" | "unknown" };
export interface UncertainRemoteOperation {
	environment: EnvironmentRef;
	id: string;
	operation: MutationReference;
	createdAt: number;
	receipt?: MutationReceipt;
}

export interface RemoteAuthGuide {
	sshCommand: string;
	authCommand: string;
	agentDir: string;
}
