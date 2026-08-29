import type { UIMessage } from "./types";

/**
 * 轮次计时派生（纯函数）：UIMessage[] → 每轮工作时长（轮末计时器数据源，codex/claude code 同款）。
 *
 * 时间口径（jsonl/事件流已有字段，纯推导零存储）：
 * - startedAt = user 消息 timestamp（提交 prompt 时刻）
 * - endedAt = 轮内各消息时刻的最大值：
 *   - assistant.timestamp：live 固化时 = turn_end 时刻（准）；历史回放 = LLM 请求发起时刻
 *   - tool.endedAt：工具执行结束（toolResult entry timestamp；工具收尾轮的决定分量）
 *   - subagent/image 消息 timestamp：结果落地时刻
 * - runEndedAt（reducer 在 agent_end/agent_settled 盖戳）只服务最后一轮定格：agent 结束晚于
 *   最后一条消息落地，与推导值取 max，保证「运行中末帧 ≤ 定格值」单调不回退
 *
 * 已知下界：正文收尾轮的历史回放 endedAt = 最后 LLM 请求发起时刻，低估最后一段输出时长
 * （jsonl 无逐轮耗时字段；工具收尾轮准确）。彻底精确需持久化逐轮耗时进会话文件，暂不做。
 */

/** 一轮的工作时间区间（endedAt 缺省 = 尚未结束/推不出结束，渲染端运行中用 now 跳动） */
export interface TurnTiming {
	/** 第几轮（从 0 计，user 消息为边界，与 TurnChanges.turnIndex 同规则） */
	turnIndex: number;
	startedAt: number;
	endedAt?: number;
}

/** 单条消息的结束时刻分量（user 自身是边界不参与；system/error 不算工作时间） */
function stampOf(message: UIMessage): number | undefined {
	if (message.kind === "assistant") {
		let max: number | undefined = message.timestamp;
		for (const tool of message.tools) {
			if (tool.endedAt !== undefined && (max === undefined || tool.endedAt > max)) max = tool.endedAt;
		}
		return max;
	}
	if (message.kind === "subagent" || message.kind === "image") return message.timestamp;
	return undefined;
}

export function deriveTurnTimings(messages: UIMessage[], runEndedAt?: number): TurnTiming[] {
	const timings: TurnTiming[] = [];
	let turnIndex = -1;
	let startedAt = 0;
	let endedAt: number | undefined;
	let open = false; // 已见 user 边界、尚未切下一轮

	const flush = (): void => {
		if (!open) return;
		// endedAt 必须晚于开始才有效：runEndedAt 残留戳 < 新轮 startedAt 时（新轮刚开始）自然落空
		timings.push({
			turnIndex,
			startedAt,
			...(endedAt !== undefined && endedAt > startedAt ? { endedAt } : {}),
		});
	};

	for (const message of messages) {
		if (message.kind === "user") {
			flush();
			turnIndex++;
			open = true;
			startedAt = message.timestamp;
			endedAt = undefined;
			continue;
		}
		if (!open) continue; // 首条 user 之前的消息不计（理论不存在）
		const stamp = stampOf(message);
		if (stamp !== undefined && (endedAt === undefined || stamp > endedAt)) endedAt = stamp;
	}
	flush();

	// 最后一轮定格：固化戳不回退（仅当其构成有效结束时刻时采纳）
	if (runEndedAt !== undefined && timings.length > 0) {
		const last = timings[timings.length - 1];
		if (last && runEndedAt > last.startedAt && (last.endedAt === undefined || runEndedAt > last.endedAt)) {
			timings[timings.length - 1] = { ...last, endedAt: runEndedAt };
		}
	}
	return timings;
}
