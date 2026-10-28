import type { CompactionRequestPolicy } from "@earendil-works/pi-coding-agent";
import { normalizeComposerMessage } from "../../session/composer-input";
import { readCompactionGuardConfig } from "./config";
import { decideRequestCompaction } from "./request-trigger";
import type { CompactionGuardConfig } from "./types";

/** 保留传输错误的 code/cause，让 SDK 的同一份重试器识别直接抛出的异常。 */
export function describeCompactionError(error: unknown): string {
	const parts: string[] = [];
	let current = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		if (typeof current !== "object") {
			parts.push(String(current));
			break;
		}
		const item = current as { message?: unknown; code?: unknown; cause?: unknown };
		if (typeof item.message === "string") parts.push(item.message);
		if (typeof item.code === "string") {
			parts.push(
				/^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)$/.test(item.code)
					? `connection error: ${item.code}`
					: item.code,
			);
		}
		current = item.cause;
	}
	return parts.join(": ") || "Compaction failed";
}

/** 主会话宿主策略。阈值和摘要预算不写入用户 settings，也不拥有执行队列。 */
export function createCompactionRequestPolicy(
	agentDir: string,
	getConfig: () => CompactionGuardConfig = () => readCompactionGuardConfig(agentDir),
): CompactionRequestPolicy {
	return {
		enabled: () => getConfig().enabled,
		evaluate: ({ tokens, contextWindow, settings }) =>
			decideRequestCompaction({
				tokens,
				contextWindow,
				reserveTokens: settings.reserveTokens,
				thresholdPct: getConfig().thresholdPct,
			}),
		normalizeMessage: normalizeComposerMessage,
		describeError: describeCompactionError,
		onResult: ({ status, ...detail }) =>
			status === "success" || status === "cancelled" ? null : { reason: status, ...detail },
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 8000 },
	};
}
