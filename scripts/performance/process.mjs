import { execFile, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
export async function cleanOwnedGroup(child) {
	if (!child?.pid || process.platform === "win32") return;
	const exists = async () => {
		// A reaped leader (or a zombie) is not a running descendant. macOS kill(-pgid,0)
		// alone can report a group which cannot actually receive another signal.
		const { stdout } = await exec("/bin/ps", ["-axo", "pid=,pgid=,stat="], { maxBuffer: 2 * 1024 * 1024 });
		return stdout
			.trim()
			.split("\n")
			.some((line) => {
				const [, group, state] = line.trim().split(/\s+/);
				return Number(group) === child.pid && !state?.startsWith("Z");
			});
	};
	const kill = (signal) => {
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	};
	if (!(await exists())) return;
	kill("SIGTERM");
	await pause(500);
	if (await exists()) {
		kill("SIGKILL");
		await pause(100);
	}
	if (await exists()) throw new Error("Owned command group remains after cleanup");
}

/** The command and its descendants belong to this group, never to an existing desktop. */
export async function runProcess({
	command = process.execPath,
	args,
	cwd,
	env,
	logFile,
	signal,
	timeoutMs = 900000,
}) {
	signal?.throwIfAborted();
	const log = await open(logFile, "wx", 0o600);
	let child, timer, killTimer, stopped, result, failure;
	const stop = (reason) => {
		stopped ??= reason;
		if (!child?.pid) return;
		try {
			if (process.platform === "win32") child.kill("SIGTERM");
			else process.kill(-child.pid, "SIGTERM");
		} catch (error) {
			if (error.code !== "ESRCH") stopped = error;
		}
		killTimer ??= setTimeout(() => {
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (error.code !== "ESRCH") stopped = error;
			}
		}, 1500);
	};
	const onAbort = () => stop(signal.reason ?? new Error("Performance command interrupted"));
	try {
		child = spawn(command, args, {
			cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["ignore", log.fd, log.fd],
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		timer = setTimeout(() => stop(new Error("Performance command timed out")), timeoutMs);
		result = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
		});
		if (stopped) throw stopped;
		if (result.code !== 0)
			throw new Error(`Command failed (${result.code ?? result.signal}); see ${logFile}`);
	} catch (error) {
		failure = error;
	} finally {
		clearTimeout(timer);
		clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
		try {
			await cleanOwnedGroup(child);
		} catch (cleanupError) {
			failure = Object.assign(
				new Error(`${failure ? `${failure.message}; ` : ""}cleanup failed: ${cleanupError.message}`),
				{ cleanupResult: { completed: false, kind: "command", errors: [cleanupError.message] } },
			);
		} finally {
			await log.close();
		}
	}
	if (failure) throw failure;
	return result;
}
