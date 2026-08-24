import {
	type CompressionBlock,
	formatRanges,
	type NudgeDecision,
	renderNudgeText,
	viableRanges,
} from "acp-kernel";
import type { RawMessage } from "../../session/messages";

/**
 * nudge 消息构造（T5，spec D6）：user-role 文本消息，只在 context 变换结果里存活
 * （不落盘、不进 UI）。per-turn 去重由扩展闭包的 nudgeShownFor 管理（turnKey =
 * 最后一条 user 消息 entry id；emergency 压力带绕过去重，billion-context-pi 同款）。
 */

/** 当前 turn 的 key（去重粒度）：最后一条 user 消息 entry id，空则用调用方给的兜底 */
export function nudgeTurnKey(coreMessages: Array<{ role: string; id?: string }>, fallback: string): string {
	for (let i = coreMessages.length - 1; i >= 0; i--) {
		const msg = coreMessages[i];
		if (msg && msg.role === "user") {
			return msg.id ?? fallback;
		}
	}
	return fallback;
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
}

/**
 * 构造 nudge 文本（renderNudgeText + 活块状态行 + 可压范围 + 最大可压范围的 example 调用）。
 * 返回 user-role 消息（RawMessage 形状，直接 push 进 rebuilt 数组）。
 */
export function buildNudgeMessage(nudge: NudgeDecision, activeBlocks: CompressionBlock[]): RawMessage {
	const rendered = renderNudgeText(nudge);
	const lines: string[] = [rendered.text];
	if (activeBlocks.length > 0) {
		const totalSummary = activeBlocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
		const totalCompressed = activeBlocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
		const tierCounts: Record<number, number> = {};
		for (const b of activeBlocks) tierCounts[b.tier] = (tierCounts[b.tier] ?? 0) + 1;
		const tierStr = Object.keys(tierCounts)
			.map(Number)
			.sort()
			.map((t) => `T${t}:${tierCounts[t]}`)
			.join(" ");
		const ids = activeBlocks
			.slice(0, 10)
			.map((b) => b.blockId)
			.join(", ");
		const extra = activeBlocks.length > 10 ? ` (+${activeBlocks.length - 10} more)` : "";
		lines.push(
			"",
			`Compressed blocks: ${activeBlocks.length} active (${tierStr}) — ${fmtTokens(totalSummary)} summary, ${fmtTokens(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`,
		);
	}
	const viable = viableRanges(nudge.compressibleRanges);
	if (viable.length > 0) {
		lines.push("", "Compressible ranges:", formatRanges(viable, nudge.protectedRanges ?? []));
		const top = [...viable].sort((a, b) => b.tokens - a.tokens)[0];
		if (top) {
			lines.push(
				"",
				`Example: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })`,
			);
		}
	}
	return {
		role: "user",
		content: lines.join("\n"),
		timestamp: Date.now(),
	};
}

/** 测试导出：nudge 文本本体（快照用） */
export function nudgeTextFor(nudge: NudgeDecision, activeBlocks: CompressionBlock[]): string {
	const message = buildNudgeMessage(nudge, activeBlocks);
	return typeof message.content === "string" ? message.content : "";
}
