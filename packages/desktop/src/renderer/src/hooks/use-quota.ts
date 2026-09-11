import type { QuotaInfo } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../api";

/** 轮询兜底（后端 5 分钟 TTL，这里的 60s 轮询只为跨会话/挂起恢复时刷新） */
const POLL_MS = 60_000;

/** 触发刷新的事件类型（额度全局有效，任一会话的 turn 结束都刷新） */
const REFRESH_EVENTS = new Set(["turn_end", "agent_settled"]);

function isRefreshEvent(type: string): boolean {
	return REFRESH_EVENTS.has(type);
}

/**
 * opencode-go 套餐额度 hook（全局，非会话级）：
 * 返回 `{ windows, updatedAt, error? }`，无 key/无订阅时返回 null（插件应隐藏）。
 * turn 结束事件驱动刷新 + 60s 轮询兜底；后端 5 分钟 TTL 限流。
 */
export function useQuota(): QuotaInfo | null {
	const [quota, setQuota] = useState<QuotaInfo | null>(null);
	const cancelledRef = useRef(false);

	const refresh = useCallback(async () => {
		try {
			const next = await getPi().getQuota();
			if (!cancelledRef.current) setQuota(next);
		} catch {
			if (!cancelledRef.current) setQuota(null);
		}
	}, []);

	useEffect(() => {
		cancelledRef.current = false;
		void refresh();
		const timer = setInterval(() => {
			void refresh();
		}, POLL_MS);
		return () => {
			cancelledRef.current = true;
			clearInterval(timer);
		};
	}, [refresh]);

	// 事件驱动刷新：任一会话 turn 结束都取一次（额度全局有效）
	useEffect(() => {
		const off = getPi().onEvent(({ event }) => {
			if (!isRefreshEvent(event.type)) return;
			void refresh();
		});
		return off;
	}, [refresh]);

	return quota;
}
