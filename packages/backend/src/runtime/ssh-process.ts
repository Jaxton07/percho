import type { ChildProcess } from "node:child_process";

/** Tracks only this local SSH child, including stream closure. */
export function trackSshProcess(child: ChildProcess): { closed: Promise<void>; terminate: () => void } {
	let isClosed = false;
	let terminating = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const closed = new Promise<void>((resolve) => {
		child.once("close", () => {
			isClosed = true;
			if (timer) clearTimeout(timer);
			resolve();
		});
	});
	return {
		closed,
		terminate: () => {
			if (isClosed || terminating) return;
			terminating = true;
			timer = setTimeout(() => child.kill("SIGKILL"), 1000);
			child.kill("SIGTERM");
		},
	};
}
