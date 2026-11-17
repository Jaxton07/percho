import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

// Capture each snapshot immediately, then serialize atomic replacements in call order.
export function createCheckpoint(file) {
	let pending = Promise.resolve();
	return {
		save(data) {
			const content = `${JSON.stringify(data, null, 2)}\n`;
			const write = async () => {
				const temporary = `${file}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
					await rename(temporary, file);
				} finally {
					await rm(temporary, { force: true });
				}
			};
			pending = pending.then(write);
			return pending;
		},
		flush: () => pending,
	};
}

// Arbitrary exception messages can include unlabelled secrets, even without paths.
const safeMessages = new Set([
	"Full stored text must remain available",
	"Stored text changed while rendering",
	"Full visible body must not be replaced by a clipped preview",
	"Rendered body must retain the full original text",
	"GC retained views",
	"GC refused",
	"Opening the isolated history timed out",
	"History open failed",
	"History and editable composer not ready",
	"openFromHistory superseded",
	"Collection stopped",
]);
export function safeErrorMessage(error) {
	const message = String(error?.message ?? error).split("\n")[0];
	return safeMessages.has(message) ? message : "Error details withheld (may contain sensitive data)";
}
