import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import {
	type EnvironmentMethod,
	executionContract,
	type MutationReceipt,
	type MutationReference,
	REMOTE_PROTOCOL_VERSION,
	type RuntimeInfo,
	type SshPreflight,
} from "@percho/shared";
import { RuntimeClient } from "./client";

import { sshArguments, validateSshAlias } from "./ssh-arguments";
import { checkSshRequirements, preflightSsh, runSsh, shellQuote } from "./ssh-preflight";

export { sshArguments, validateSshAlias } from "./ssh-arguments";

// The development artifact is prepared explicitly for M1. Release metadata replaces this selector in deployment.
const entry = '"$HOME/.local/share/percho/releases/development/entry.mjs"';
const remoteCommand = (command: "start" | "bridge", node: string) =>
	`exec ${shellQuote(node)} ${entry} ${command}`;

function checkContract(info: RuntimeInfo): void {
	const expected = executionContract();
	if (
		!info ||
		info.protocol !== REMOTE_PROTOCOL_VERSION ||
		typeof info.environmentId !== "string" ||
		!info.environmentId ||
		typeof info.instanceId !== "string" ||
		!info.instanceId ||
		!Number.isSafeInteger(info.uid) ||
		info.uid < 0 ||
		typeof info.canonicalAgentDir !== "string" ||
		!info.canonicalAgentDir.startsWith("/") ||
		typeof info.sdkVersion !== "string" ||
		info.eventContract !== expected.eventContract ||
		!Array.isArray(info.methods) ||
		!Array.isArray(info.subscriptions) ||
		!expected.methods.every((method) => info.methods.includes(method)) ||
		!expected.subscriptions.every((method) => info.subscriptions.includes(method))
	)
		throw new Error("Remote runtime has an incompatible execution/event contract");
}

async function ensureStarted(alias: string, signal: AbortSignal, node: string): Promise<RuntimeInfo> {
	return JSON.parse(await runSsh(sshArguments(alias, remoteCommand("start", node)), signal)) as RuntimeInfo;
}

export class SshRuntimeConnection {
	private constructor(
		readonly info: RuntimeInfo,
		private readonly client: RuntimeClient,
		private readonly closeBridge: () => void,
	) {}
	static async connect(
		alias: string,
		options: {
			signal: AbortSignal;
			onEvent: (method: string, payload: unknown) => void;
			onClose: () => void;
			clientTag?: string;
			preflight?: SshPreflight;
		},
	): Promise<SshRuntimeConnection> {
		validateSshAlias(alias);
		const probe = await preflightSsh(alias, options.signal);
		checkSshRequirements(probe);
		if (
			options.preflight &&
			JSON.stringify([
				probe.target,
				probe.uid,
				probe.home,
				probe.node,
				probe.nodeVersion,
				probe.agentDir,
				probe.environmentId,
			]) !==
				JSON.stringify([
					options.preflight.target,
					options.preflight.uid,
					options.preflight.home,
					options.preflight.node,
					options.preflight.nodeVersion,
					options.preflight.agentDir,
					options.preflight.environmentId,
				])
		)
			throw new Error("Remote identity changed since preflight; check again before connecting");
		if (!probe.installed)
			throw new Error("NOT_INSTALLED: Remote runtime is not installed; use Install and connect");
		const started = await ensureStarted(alias, options.signal, probe.node);
		checkContract(started);
		const child = spawn("ssh", sshArguments(alias, remoteCommand("bridge", probe.node)), {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 16384) stderr += chunk.toString("utf8");
		});
		const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
		const client = RuntimeClient.fromStream(stream, options.onEvent);
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			client.close();
			child.kill();
		};
		child.on("error", () => {
			stream.destroy(new Error(stderr.trim() || "SSH bridge closed"));
		});
		child.once("close", () => {
			stream.destroy();
			options.onClose();
		});
		try {
			const attached = await client.attach(options.clientTag ?? randomUUID());
			checkContract(attached.info);
			if (
				attached.info.instanceId !== started.instanceId ||
				attached.info.environmentId !== started.environmentId
			)
				throw new Error("Remote runtime changed during connection; reconnect explicitly");
			if (options.signal.aborted) throw new Error("SSH connection cancelled");
			// Initial registry synchronization is required before this controller can submit new work.
			await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
			return new SshRuntimeConnection(attached.info, client, close);
		} catch (error) {
			close();
			throw error;
		}
	}
	invoke(method: EnvironmentMethod, args: unknown): Promise<unknown> {
		return this.client.invoke(method, args);
	}
	queryReceipt(operation: MutationReference): Promise<MutationReceipt> {
		return this.client.queryReceipt(operation);
	}
	disconnect(): void {
		this.closeBridge();
	}
}
