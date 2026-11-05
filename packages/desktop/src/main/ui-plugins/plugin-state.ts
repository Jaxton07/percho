import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JsonStore, JsonStoreCorruptedError } from "@percho/backend";
import { app } from "electron";
import { NAME_RE } from "./manifest";

/** 每个插件一份 JSON，总字节上限；超出直接拒绝（插件存的是位置、开关这类小状态） */
export const PLUGIN_STATE_MAX_BYTES = 64 * 1024;
/** key 只允许短标识，避免当作任意存储桶使用，也避免与对象原型属性冲突 */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_KEYS = 64;

export type PluginStateRecord = Record<string, JsonValue>;
/** 能原样 JSON 往返的纯数据 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function stateDir(): string {
	return join(app.getPath("userData"), "ui-plugin-state");
}

function storeFor(name: string): JsonStore<PluginStateRecord> {
	return new JsonStore<PluginStateRecord>({
		path: join(stateDir(), `${name}.json`),
		defaultValue: () => ({}),
	});
}

export function isValidPluginStateKey(key: unknown): key is string {
	return typeof key === "string" && KEY_RE.test(key);
}

/** 读整份状态；文件缺失/损坏 → 空对象（坏文件不能让插件崩溃，下次写入会覆盖） */
export async function readPluginState(name: string): Promise<PluginStateRecord> {
	if (!NAME_RE.test(name)) return {};
	return sanitize(await storeFor(name).read());
}

/**
 * 写一个 key（value 为 undefined 时删除）。value 必须能原样 JSON 往返；
 * 写入串行化在单个插件的 JsonStore 上，整份大小超限时拒绝且不改动已有数据。
 */
export async function writePluginState(name: string, key: string, value: unknown): Promise<void> {
	if (!NAME_RE.test(name)) throw new Error("Invalid plugin name");
	if (!isValidPluginStateKey(key)) throw new Error("Invalid state key");
	const normalized = value === undefined ? undefined : toJsonValue(value);
	await mkdir(stateDir(), { recursive: true });
	const mutate = (current: unknown) => {
		const next: PluginStateRecord = { ...sanitize(current) };
		if (normalized === undefined) delete next[key];
		else next[key] = normalized;
		if (Object.keys(next).length > MAX_KEYS) throw new Error(`Too many state keys (max ${MAX_KEYS})`);
		if (Buffer.byteLength(JSON.stringify(next), "utf8") > PLUGIN_STATE_MAX_BYTES)
			throw new Error(`Plugin state exceeds ${PLUGIN_STATE_MAX_BYTES} bytes`);
		return next;
	};
	const store = storeFor(name);
	try {
		await store.update(mutate);
	} catch (error) {
		if (!(error instanceof JsonStoreCorruptedError)) throw error;
		// 状态文件坏了：只是插件的位置/开关，不值得让保存永久失败，从空状态重写整份
		await store.write(mutate({}));
	}
}

/** 经 JSON 往返得到纯数据（去掉函数、Date 变字符串等）；循环引用/BigInt 等无法序列化时报错 */
function toJsonValue(value: unknown): JsonValue {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new Error(
			`State value must be JSON-serialisable: ${error instanceof Error ? error.message : error}`,
		);
	}
	if (encoded === undefined) throw new Error("State value must be JSON-serialisable");
	try {
		return JSON.parse(encoded) as JsonValue;
	} catch {
		throw new Error("State value must be JSON-serialisable");
	}
}

function sanitize(value: unknown): PluginStateRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, JsonValue>).filter(([key]) => isValidPluginStateKey(key)),
	);
}
