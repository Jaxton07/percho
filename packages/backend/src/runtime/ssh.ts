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
} from "@percho/shared";
import { RuntimeClient } from "./client";

/** A concrete configured Host alias, never a destination expression or remote command supplied by renderer. */
export function validateSshAlias(alias: string): string {
	if (typeof alias !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(alias))
		throw new Error("Enter a concrete SSH Host alias");
	return alias;
}
export function sshArguments(alias: string, command: string): string[] {
	return [
		"-T",
		"-oBatchMode=yes",
		"-oStrictHostKeyChecking=yes",
		"-oForwardAgent=no",
		"-oClearAllForwardings=yes",
		"-oControlMaster=no",
		"-oConnectTimeout=10",
		"--",
		validateSshAlias(alias),
		command,
	];
}

// The development artifact is prepared explicitly for M1. Release metadata replaces this selector in deployment.
const entry = '"$HOME/.local/share/percho/releases/development/entry.mjs"';
const remoteCommand = (command: "start" | "bridge") => `exec node ${entry} ${command}`;

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

async function ensureStarted(alias: string, signal: AbortSignal): Promise<RuntimeInfo> {
	return await new Promise<RuntimeInfo>((resolve, reject) => {
		const child = spawn("ssh", sshArguments(alias, remoteCommand("start")), {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		const output: Buffer[] = [];
		let outputSize = 0;
		let error = "";
		const timer = setTimeout(() => child.kill(), 25_000);
		child.stdout.on("data", (chunk: Buffer) => {
			output.push(chunk);
			outputSize += chunk.byteLength;
			if (outputSize > 1024 * 1024) child.kill();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (error.length < 16384) error += chunk.toString("utf8");
		});
		child.once("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(error.trim() || "SSH runtime startup failed"));
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(output).toString("utf8")) as RuntimeInfo);
			} catch {
				reject(new Error("Invalid SSH runtime startup response"));
			}
		});
	});
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
		},
	): Promise<SshRuntimeConnection> {
		const started = await ensureStarted(validateSshAlias(alias), options.signal);
		checkContract(started);
		const child = spawn("ssh", sshArguments(alias, remoteCommand("bridge")), {
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
			await client.invoke("getLoadedSessions");
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
