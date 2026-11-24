import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { getPi } from "../api";

/** 当前渲染的插件名；由 PluginBoundary 提供，插件代码无法伪造（hook 只从 context 读） */
export const PluginNameContext = createContext<string | null>(null);

type Snapshot = { loaded: boolean; values: Record<string, unknown> };
type Entry = { snapshot: Snapshot; listeners: Set<() => void>; loading?: Promise<void> };

const WRITE_DEBOUNCE_MS = 300;
const entries = new Map<string, Entry>();
const pendingWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; value: unknown }>();

function entryFor(name: string): Entry {
	let entry = entries.get(name);
	if (!entry) {
		entry = { snapshot: { loaded: false, values: {} }, listeners: new Set() };
		entries.set(name, entry);
	}
	return entry;
}

function publish(name: string, values: Record<string, unknown>): void {
	const entry = entryFor(name);
	entry.snapshot = { loaded: true, values };
	for (const listener of entry.listeners) listener();
}

function ensureLoaded(name: string): void {
	const entry = entryFor(name);
	if (entry.snapshot.loaded || entry.loading) return;
	entry.loading = getPi()
		.uiPluginsReadState({ name })
		.then(
			// 加载期间已写入的 key 以本地为准，不被磁盘旧值覆盖
			(stored) => publish(name, { ...stored, ...entry.snapshot.values }),
			(error) => {
				console.warn(`[ui-plugins] ${name} 读取状态失败:`, error);
				publish(name, entry.snapshot.values);
			},
		);
}

/** 拖动等高频更新只在静止 300ms 后落盘一次；同一 key 新值覆盖旧值 */
function scheduleWrite(name: string, key: string, value: unknown): void {
	const id = `${name}\u0000${key}`;
	const pending = pendingWrites.get(id);
	if (pending) clearTimeout(pending.timer);
	const timer = setTimeout(() => {
		pendingWrites.delete(id);
		void getPi()
			.uiPluginsWriteState(value === undefined ? { name, key } : { name, key, value })
			.then((result) => {
				if (!result.ok) console.warn(`[ui-plugins] ${name} 保存状态失败:`, result.error);
			});
	}, WRITE_DEBOUNCE_MS);
	pendingWrites.set(id, { timer, value });
}

/** 立刻落盘所有排队中的写入（窗口关闭前调用，避免最后一次拖动丢失） */
export function flushPluginStateWrites(): void {
	for (const [id, pending] of pendingWrites) {
		clearTimeout(pending.timer);
		pendingWrites.delete(id);
		const [name, key] = id.split("\u0000") as [string, string];
		void getPi().uiPluginsWriteState(
			pending.value === undefined ? { name, key } : { name, key, value: pending.value },
		);
	}
}

/**
 * 插件持久化状态：`const [pos, setPos, ready] = usePluginState("position", { x: 0, y: 0 })`。
 * - 每个插件只能读写自己的状态（插件名由宿主注入，不是参数）；重启 Percho 后仍在。
 * - value 必须是 JSON 数据；整份上限 64 KB、最多 64 个 key（超出时保存失败，界面上仍是新值）。
 * - ready 为 false 表示还在读磁盘，此时返回的是 fallback；需要「读到再显示」的插件可据此延后渲染。
 */
export function usePluginState<T>(
	key: string,
	fallback: T,
): [T, (next: T | ((prev: T) => T)) => void, boolean] {
	const name = useContext(PluginNameContext);
	const fallbackRef = useRef(fallback);
	fallbackRef.current = fallback;
	const subscribe = useCallback(
		(listener: () => void) => {
			if (!name) return () => {};
			const entry = entryFor(name);
			entry.listeners.add(listener);
			return () => entry.listeners.delete(listener);
		},
		[name],
	);
	const snapshot = useSyncExternalStore(subscribe, () => (name ? entryFor(name).snapshot : EMPTY));
	useEffect(() => {
		if (name) ensureLoaded(name);
	}, [name]);
	const stored = Object.hasOwn(snapshot.values, key) ? (snapshot.values[key] as T) : fallback;
	const set = useCallback(
		(next: T | ((prev: T) => T)) => {
			if (!name) return;
			const entry = entryFor(name);
			const prev = Object.hasOwn(entry.snapshot.values, key)
				? (entry.snapshot.values[key] as T)
				: fallbackRef.current;
			const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
			const values = { ...entry.snapshot.values };
			if (value === undefined) delete values[key];
			else values[key] = value;
			entry.snapshot = { loaded: entry.snapshot.loaded, values };
			for (const listener of entry.listeners) listener();
			scheduleWrite(name, key, value);
		},
		[name, key],
	);
	return [stored, set, snapshot.loaded || !name];
}

const EMPTY: Snapshot = { loaded: true, values: {} };

/** internal：测试用，清空内存缓存与排队写入 */
export function resetPluginStateForTests(): void {
	for (const pending of pendingWrites.values()) clearTimeout(pending.timer);
	pendingWrites.clear();
	entries.clear();
}
