import { useEffect, useRef, useState } from "react";

/** working → worked 切换的缓冲时长：turn/工具间隙内不闪烁（与桌面同参数） */
const HYSTERESIS_MS = 1500;

/**
 * working 信号的滞后缓冲（桌面 use-shown-working 同款语义）：
 * 信号消失后保持 HYSTERESIS_MS 才翻转；endImmediately（正文在输出 / run 终结）立即翻转。
 */
export function useShownWorking(working: boolean, endImmediately = false): boolean {
	const [shownWorking, setShownWorking] = useState(working);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
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
	}, [working, shownWorking, endImmediately]);
	return shownWorking;
}
