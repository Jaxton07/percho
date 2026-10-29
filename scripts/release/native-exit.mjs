/** A quit request may destroy CDP before its reply; the native process is the receipt. */
export function expectNativeExit(child, request, { timeoutMs = 15000 } = {}) {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			reject(new Error("Application exited before quit was requested"));
			return;
		}
		let requestError;
		const finish = (error) => {
			clearTimeout(timer);
			child.removeListener("exit", exited);
			child.removeListener("error", failed);
			if (error) reject(error);
			else resolve();
		};
		const exited = (code, signal) =>
			finish(code === 0 ? undefined : new Error(`Application exited with ${signal ?? code}`));
		const failed = (error) => finish(error);
		const timer = setTimeout(
			() => finish(new Error("Timed out: native process exit", { cause: requestError })),
			timeoutMs,
		);
		child.once("exit", exited);
		child.once("error", failed);
		// Observe errors without waiting for a CDP response that may never arrive.
		// An acknowledged request alone is also insufficient: exit(0) is mandatory.
		void Promise.resolve()
			.then(request)
			.catch((error) => {
				requestError = error;
			});
	});
}
