import { environmentKey, type QuotaInfo } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../environment-api";
import { useActiveEnvironment } from "./use-active-environment";

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
	const environment = useActiveEnvironment();
	const key = environmentKey(environment);
	const target = useRef(key);
	target.current = key;
	const [quota, setQuota] = useState<{ key: string; value: QuotaInfo | null } | null>(null);
	const cancelledRef = useRef(false);

	const refresh = useCallback(async () => {
		try {
			const next = await getExecutionApi(environment).getQuota();
			if (!cancelledRef.current && target.current === key) setQuota({ key, value: next });
		} catch {
			if (!cancelledRef.current && target.current === key) setQuota({ key, value: null });
		}
	}, [environment, key]);

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
		const off = getExecutionApi(environment).onEvent(({ event }) => {
			if (!isRefreshEvent(event.type)) return;
			void refresh();
		});
		return off;
	}, [refresh, environment]);

	return quota?.key === key ? quota.value : null;
}
