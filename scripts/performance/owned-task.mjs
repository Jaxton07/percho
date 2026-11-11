/** Wait for an owned callback to settle even after cancellation; never detach it. */
export async function runOwnedTask({ signal, cancel = () => {} }, callback) {
	signal?.throwIfAborted();
	let cancellationError;
	const onAbort = () => {
		try {
			cancel();
		} catch (error) {
			cancellationError = error;
		}
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const value = await callback();
		if (cancellationError) throw cancellationError;
		signal?.throwIfAborted();
		return value;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
