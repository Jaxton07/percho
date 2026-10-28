import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function run(command, args, options = {}) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", ...options });
		const stop = (signal) => child.kill(signal);
		const interrupt = () => stop("SIGINT");
		const terminate = () => stop("SIGTERM");
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", terminate);
		const cleanup = () => {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			if (code === 0) resolve();
			else reject(new Error(`${command} exited with ${signal ?? code}`));
		});
	});
}

export async function sha256(path) {
	const hash = createHash("sha256");
	for await (const data of createReadStream(path)) hash.update(data);
	return hash.digest("hex");
}
