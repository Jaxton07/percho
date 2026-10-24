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

function releaseEntry(releaseId: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(releaseId))
		throw new Error("Invalid installed runtime release");
	return `"$HOME/.local/share/percho/releases/${releaseId}/entry.mjs"`;
}
const remoteCommand = (command: "start" | "bridge", node: string, releaseId: string) =>
	`exec ${shellQuote(node)} ${releaseEntry(releaseId)} ${command}`;

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

async function ensureStarted(
	alias: string,
	signal: AbortSignal,
	node: string,
	releaseId: string,
): Promise<RuntimeInfo> {
	return JSON.parse(
		await runSsh(sshArguments(alias, remoteCommand("start", node, releaseId)), signal),
	) as RuntimeInfo;
}

export function remoteAuthGuide(alias: string, node: string, releaseId = "development") {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(releaseId))
		throw new Error("Invalid installed runtime release");
	validateSshAlias(alias);
	if (!node.startsWith("/")) throw new Error("Remote Node path must be absolute");
	return {
		sshCommand: `ssh -t -oStrictHostKeyChecking=yes -oForwardAgent=no -oClearAllForwardings=yes -oControlMaster=no -oControlPath=none -- ${alias}`,
		authCommand: `exec ${shellQuote(node)} "$HOME/.local/share/percho/releases/${releaseId}/entry.mjs" auth`,
	};
}

export class SshRuntimeConnection {
	private constructor(
		readonly info: RuntimeInfo,
		private readonly client: RuntimeClient,
		private readonly closeBridge: () => void,
		private readonly alias: string,
		private readonly node: string,
		private readonly signal: AbortSignal,
		private readonly releaseId: string,
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
		if (probe.serviceState === "running") checkContract(probe.service as RuntimeInfo);
		if (probe.serviceState === "unreachable")
			throw new Error(
				"Runtime owner may be active but unreachable; verify it before installing or starting another release",
			);
		if (!probe.installed && probe.serviceState !== "running")
			throw new Error("NOT_INSTALLED: Remote runtime is not installed; use Install and connect");
		const releaseId = probe.service?.releaseId ?? probe.installedReleaseId ?? "development";
		const started =
			probe.serviceState === "running"
				? (probe.service as RuntimeInfo)
				: await ensureStarted(alias, options.signal, probe.node, releaseId);
		checkContract(started);
		const child = spawn("ssh", sshArguments(alias, remoteCommand("bridge", probe.node, releaseId)), {
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
		let notified = false;
		const ended = () => {
			if (notified) return;
			notified = true;
			close();
			options.onClose();
		};
		stream.once("close", ended);
		child.once("close", () => {
			stream.destroy();
			ended();
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
			return new SshRuntimeConnection(
				attached.info,
				client,
				close,
				alias,
				probe.node,
				options.signal,
				releaseId,
			);
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
	async stopService(): Promise<void> {
		try {
			await this.client.stop();
		} catch {
			/* A closed bridge or stop ACK does not prove owner exit. */
		}
		this.closeBridge();
		const confirmed = JSON.parse(
			await runSsh(
				sshArguments(
					this.alias,
					`exec ${shellQuote(this.node)} ${releaseEntry(this.releaseId)} wait-stopped`,
				),
				this.signal,
				45_000,
			),
		);
		if (confirmed.stopped !== true) throw new Error("Remote service stop is unconfirmed");
	}
	disconnect(): void {
		this.closeBridge();
	}
}
