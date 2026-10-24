import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { RuntimeClient } from "./client";
import { acquireOwner, type RuntimePaths, runtimePaths } from "./paths";

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function inspect(paths: RuntimePaths) {
	const client = await RuntimeClient.connect(paths.socket);
	try {
		return await client.inspect();
	} finally {
		client.close();
	}
}

async function start(paths: RuntimePaths) {
	try {
		return await inspect(paths);
	} catch (error) {
		if (!["ENOENT", "ECONNREFUSED", "NOT_READY"].includes((error as NodeJS.ErrnoException).code ?? ""))
			throw error;
	}
	const probe = await acquireOwner(paths);
	if (!probe)
		throw new Error("Runtime owner is active but its socket is unavailable; refusing a second service");
	await probe.close();
	const log = await open(
		join(paths.logs, "runtime.log"),
		constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await log.chmod(0o600);
		const stat = await log.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("Invalid runtime log path");
		const child = spawn(process.execPath, [process.argv[1] ?? "", "serve", "--root", paths.root], {
			detached: true,
			stdio: ["ignore", log.fd, log.fd],
			env: { ...process.env, PI_CODING_AGENT_DIR: paths.agent },
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.unref();
	} finally {
		await log.close();
	}
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			return await inspect(paths);
		} catch (error) {
			if (!["ENOENT", "ECONNREFUSED", "NOT_READY"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw error;
		}
		await pause(100);
	}
	throw new Error(`Runtime did not become ready; inspect ${join(paths.logs, "runtime.log")}`);
}

async function bridge(paths: RuntimePaths): Promise<void> {
	const socket = connect(paths.socket);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.on("error", (error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
		process.stdin.destroy();
	});
	process.stdout.on("error", () => socket.destroy());
	process.stdin.on("error", () => socket.destroy());
	socket.once("close", () => process.stdin.destroy());
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
}

export async function runRuntimeCli(root: string, command: string): Promise<void> {
	if (process.platform !== "linux") throw new Error("The remote runtime supports glibc Linux only");
	const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
	if (!report.header?.glibcVersionRuntime)
		throw new Error("The remote runtime requires glibc; musl/Alpine is unsupported");
	const paths = await runtimePaths(root);
	process.env.PI_CODING_AGENT_DIR = paths.agent;
	if (command === "bridge") return bridge(paths);
	if (command === "serve") {
		const { startRuntimeServer } = await import("./server");
		const server = await startRuntimeServer(paths);
		for (const signal of ["SIGINT", "SIGTERM"] as const)
			process.once(signal, () => {
				void server.stop().catch((error) => {
					process.stderr.write(`${String(error)}\n`);
					process.exitCode = 1;
				});
			});
		return;
	}
	if (command === "start") {
		process.stdout.write(`${JSON.stringify(await start(paths))}\n`);
		return;
	}
	if (command === "status") {
		process.stdout.write(`${JSON.stringify(await inspect(paths))}\n`);
		return;
	}
	if (command === "stop") {
		const client = await RuntimeClient.connect(paths.socket);
		try {
			await client.attach(`maintenance-${randomUUID()}`);
			await client.stop();
		} finally {
			client.close();
		}
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const owner = await acquireOwner(paths);
			if (owner) {
				await owner.close();
				process.stdout.write('{"stopped":true}\n');
				return;
			}
			await pause(100);
		}
		throw new Error("Runtime has not fully released its owner lock; refusing to start another service");
	}
	throw new Error("Usage: node entry.mjs <start|status|bridge|stop> [--root <private-directory>]");
}
