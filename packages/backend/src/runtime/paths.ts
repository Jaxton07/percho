import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimePaths {
	root: string;
	agent: string;
	run: string;
	logs: string;
	socket: string;
	lock: string;
}

async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o077) !== 0
	)
		throw new Error(`Runtime directory must be owned by the current user with mode 0700: ${path}`);
}

export async function runtimePaths(
	input = join(homedir(), ".local", "share", "percho"),
): Promise<RuntimePaths> {
	await privateDirectory(resolve(input));
	const root = await realpath(resolve(input));
	for (const name of ["agent", "releases", "staging", "run", "logs"])
		await privateDirectory(join(root, name));
	const run = join(root, "run");
	const suffix = createHash("sha256").update(`${process.getuid?.()}:${root}`).digest("hex").slice(0, 12);
	const socket = join(run, `${suffix}.sock`);
	if (Buffer.byteLength(socket) >= 104) throw new Error("Runtime root is too long for a private Unix socket");
	return {
		root,
		agent: join(root, "agent"),
		run,
		logs: join(root, "logs"),
		socket,
		lock: join(run, "owner.lock"),
	};
}

/** flock locks the shared open-file description; this process retains the descriptor after the helper exits. */
export async function acquireOwner(paths: RuntimePaths): Promise<FileHandle | null> {
	if (process.platform !== "linux") throw new Error("The independent runtime requires glibc Linux");
	const file = await open(paths.lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("Invalid runtime owner lock");
		await file.chmod(0o600);
		const code = await new Promise<number | null>((resolveCode, reject) => {
			const helper = spawn("flock", ["-n", "-E", "75", "3"], {
				stdio: ["ignore", "ignore", "pipe", file.fd],
			});
			helper.once("error", reject);
			helper.once("exit", resolveCode);
		});
		if (code === 0) return file;
		if (code !== 75)
			throw new Error(`flock failed (${code}); install util-linux before starting the runtime`);
		await file.close();
		return null;
	} catch (error) {
		await file.close();
		throw error;
	}
}

export async function ownerIsCurrent(paths: RuntimePaths, file: FileHandle): Promise<boolean> {
	try {
		const [held, current] = await Promise.all([file.stat(), lstat(paths.lock)]);
		return held.ino === current.ino && held.dev === current.dev && !current.isSymbolicLink();
	} catch {
		return false;
	}
}
