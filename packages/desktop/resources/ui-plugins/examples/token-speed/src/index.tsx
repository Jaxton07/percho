import { useLanguage, useSessionsStore, useTurnSpeed } from "@percho/plugin-api";
import { memo } from "react";

/**
 * Token 速度 chip（随包示例，0.4 口径版）：
 * - useTurnSpeed(sessionId)：宿主权威聚合 + 渲染端实测 prefill 拆分 + 流式 live 估算
 * - **口径必须标注**：`dec` = 已剔除 prefill 的纯生成速率；`api` = 含 prefill/网络（长 prompt 轮
 *   会明显偏低，与 dec 不可裸比较）。工具执行/排队两种口径都不计入（wall 口径会稀释 ≈7×）
 * - 生成中：显示 live 估算（滚动窗口实测，前缀 ≈），权威值到达即覆盖
 * - 返回 null（新会话页、无有效样本且无 live）→ 自动隐藏（宁缺勿错）
 * - composer.footer 行内区域（ContextRing 旁）：宿主不包定位容器，chip 自身即交互子树
 */
export const TokenSpeed = memo(function TokenSpeed() {
	const lang = useLanguage();
	const sessionId = useSessionsStore((s) => s.activeSessionId);
	const speed = useTurnSpeed(sessionId);
	if (!speed) return null;

	// 生成中优先显示 live（瞬时反馈），否则显示权威口径值
	const showLive = speed.live && speed.liveSpeed !== null && speed.samples === 0;
	const value = showLive ? (speed.liveSpeed ?? 0) : speed.speed;
	const zh = lang !== "en";

	return (
		<span
			className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-2"
			title={zh ? detailZh(speed) : detailEn(speed)}
		>
			<span className="text-ink-dim">⚡</span>
			{showLive ? "≈" : ""}
			{formatSpeed(value)}
			<span className="text-[9px] text-ink-faint">
				{showLive ? "live" : speed.metric === "decode" ? "dec" : "api"}
			</span>
		</span>
	);
});

function detailZh(speed: NonNullable<ReturnType<typeof useTurnSpeed>>): string {
	const lines: string[] = [];
	lines.push(
		`${speed.metric === "decode" ? "生成速率（已剔除 prefill）" : "生成速率（含 prefill/网络）"}：${formatSpeed(speed.speed)} tok/s`,
	);
	if (speed.apiSpeed !== null)
		lines.push(`api 口径：${formatSpeed(speed.apiSpeed)} tok/s · ${speed.samples} 条 LLM 消息`);
	if (speed.decodeSpeed !== null) lines.push(`decode 口径：${formatSpeed(speed.decodeSpeed)} tok/s`);
	if (speed.prefillMs !== null) {
		lines.push(
			`prefill 合计 ${(speed.prefillMs / 1000).toFixed(1)}s / api 合计 ${(speed.apiMs / 1000).toFixed(1)}s`,
		);
	}
	if (speed.promptTokens > 0) lines.push(`本轮 prompt 累计 ${compact(speed.promptTokens)} token`);
	lines.push(`输出 ${speed.outputTokens} token（不含工具执行与排队时间）`);
	if (speed.model) lines.push(`模型 ${speed.model}`);
	if (speed.session.speed !== null) {
		lines.push(`本会话累计 ${speed.session.outputTokens} token · ${formatSpeed(speed.session.speed)} tok/s`);
	}
	if (speed.turns.length > 1) {
		lines.push(
			`近 ${speed.turns.length} 轮：${speed.turns
				.slice(-8)
				.map((turn) => formatSpeed(turn.speed ?? 0))
				.join(" · ")}`,
		);
	}
	return lines.join("\n");
}

function detailEn(speed: NonNullable<ReturnType<typeof useTurnSpeed>>): string {
	const lines: string[] = [];
	lines.push(
		`${speed.metric === "decode" ? "Generation rate (prefill excluded)" : "Generation rate (prefill + network included)"}: ${formatSpeed(speed.speed)} tok/s`,
	);
	if (speed.apiSpeed !== null)
		lines.push(`api: ${formatSpeed(speed.apiSpeed)} tok/s · ${speed.samples} LLM messages`);
	if (speed.decodeSpeed !== null) lines.push(`decode: ${formatSpeed(speed.decodeSpeed)} tok/s`);
	if (speed.prefillMs !== null)
		lines.push(`prefill ${(speed.prefillMs / 1000).toFixed(1)}s of api ${(speed.apiMs / 1000).toFixed(1)}s`);
	if (speed.promptTokens > 0) lines.push(`prompt this turn: ${compact(speed.promptTokens)} tokens`);
	lines.push(`${speed.outputTokens} tokens output (tool time excluded)`);
	if (speed.model) lines.push(`model ${speed.model}`);
	if (speed.session.speed !== null)
		lines.push(`session: ${speed.session.outputTokens} tokens · ${formatSpeed(speed.session.speed)} tok/s`);
	return lines.join("\n");
}

function formatSpeed(speed: number): string {
	return speed >= 100 ? String(Math.round(speed)) : speed.toFixed(1);
}

function compact(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
