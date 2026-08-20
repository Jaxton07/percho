import { useEffect, useRef, useState } from "react";

/** working → worked 切换的缓冲时长：turn/工具间隙内不闪烁 */
const HYSTERESIS_MS = 1500;

/**
 * working 信号的滞后缓冲：信号消失后保持 HYSTERESIS_MS 才翻转为 false（turn/工具间隙不闪烁）；
 * endImmediately = true（正文在输出，或 run 已终结 agentActive=false）时立即翻转，不做缓冲——
 * run 终结后 working 不可能再翻回（willRetry 会保持 agentActive），滞后纯是结束/中止后的滞留。
 * resetKey（可选）变化时：清 pending timer、立即以当前 working 重置，跳过缓冲——
 * MessageList 不随会话 remount，旧会话的滞后状态不得泄漏到新会话；
 * MetaGroup 组已按会话 key remount，无需传。
 * MetaGroup 标题行与 CenterOrb 中央动画共用同一节奏，两者显隐一致。
 */
export function useShownWorking(working: boolean, endImmediately = false, resetKey?: string | null): boolean {
	const [shownWorking, setShownWorking] = useState(working);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevKeyRef = useRef(resetKey);
	useEffect(() => {
		// 会话切换：立即对齐新会话的 working 信号（新会话 idle → 立刻淡出；
		// 新会话也在工作 → 保持 true 不中断，动画连续播放零重初始化）
		if (prevKeyRef.current !== resetKey) {
			prevKeyRef.current = resetKey;
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShownWorking(working);
			return;
		}
		if (working) {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShownWorking(true);
		} else if (shownWorking) {
			if (endImmediately) {
				setShownWorking(false);
				return;
			}
			if (!timerRef.current) {
				timerRef.current = setTimeout(() => {
					timerRef.current = null;
					setShownWorking(false);
				}, HYSTERESIS_MS);
			}
		}
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [working, shownWorking, endImmediately, resetKey]);
	return shownWorking;
}
