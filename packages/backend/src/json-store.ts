import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createLogger } from "./log";

const log = createLogger("json-store");

/**
 * 统一 JSON 持久化（8 处站点共用）：同目录 tmp + rename 原子写、损坏区分 ENOENT/损坏、
 * async 版 per-path 串行化防读改写竞态。
 *
 * 语义要点（spec D2）：
 * - **缓存不进 JsonStore**：各站点的内存 cache / normalize / mtime loader 原样保留，
 *   本类只是 IO 原语的统一实现。
 * - **read 系损坏回退 default**（记 warn）：插件系统/设置页依赖它不阻塞启动。
 * - **update 系损坏抛 `JsonStoreCorruptedError` 拒写**：update 紧跟整文件覆盖，
 *   静默继续 = 用 default 覆盖真数据（B6 根除）。调用方（IPC handler）把错误传给 renderer。
 */

/** 读取结果的 tri-state：ok/missing 都有可用值，corrupted 只携带错误 */
export type ReadResult<T> =
	| { kind: "ok" | "missing"; value: T }
	| { kind: "corrupted"; error: unknown };

/** update 路径遇到损坏文件时抛出；message 面向用户（经 IPC 传给 renderer 展示） */
export class JsonStoreCorruptedError extends Error {
	constructor(
		readonly path: string,
		readonly cause?: unknown,
	) {
		super(`配置文件损坏：${path}，请修复或删除后重试`);
		this.name = "JsonStoreCorruptedError";
	}
}

export interface JsonStoreOptions<T> {
	/** 目标 JSON 文件绝对路径 */
	path: string;
	/** 文件缺失/损坏时 read 系使用的回退值（每次调用现取，避免共享可变引用） */
	defaultValue: () => T;
	/** 文件权限（如 auth 类 0600）；缺省走进程 umask */
	mode?: number;
	/** 解析钩子（默认 JSON.parse）；models.json 等 JSONC 文件用它先剥注释 */
	parse?: (raw: string) => T;
}

/** async 版 per-path 操作队列：串行化同路径的 update/write（load→merge→write 竞态修复）；空则清理 */
const queues = new Map<string, Promise<void>>();

function enqueue<T>(path: string, op: () => Promise<T>): Promise<T> {
	const prev = queues.get(path) ?? Promise.resolve();
	const next = prev.then(op, op); // 前序失败不影响本次执行
	const settled = next.then(
		() => {},
		() => {},
	);
	queues.set(path, settled);
	void settled.then(() => {
		if (queues.get(path) === settled) queues.delete(path);
	});
	return next;
}

function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export class JsonStore<T> {
	private readonly path: string;
	private readonly defaultValue: () => T;
	private readonly mode: number | undefined;
	private readonly parse: (raw: string) => T;

	constructor(options: JsonStoreOptions<T>) {
		this.path = options.path;
		this.defaultValue = options.defaultValue;
		this.mode = options.mode;
		this.parse = options.parse ?? (JSON.parse as (raw: string) => T);
	}

	/** 读取原始状态（不回退）：ENOENT → missing+default；解析失败 → corrupted；其他 IO 错误上抛 */
	private classify(text: string): ReadResult<T> {
		try {
			return { kind: "ok", value: this.parse(text) };
		} catch (error) {
			return { kind: "corrupted", error };
		}
	}

	private async readRaw(): Promise<ReadResult<T>> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (err) {
			if (isEnoent(err)) return { kind: "missing", value: this.defaultValue() };
			throw err;
		}
		return this.classify(text);
	}

	private readRawSync(): ReadResult<T> {
		let text: string;
		try {
			text = readFileSync(this.path, "utf8");
		} catch (err) {
			if (isEnoent(err)) return { kind: "missing", value: this.defaultValue() };
			throw err;
		}
		return this.classify(text);
	}

	/** 同目录 tmp + rename 原子写；失败清理 tmp 后重抛（跨卷 EXDEV 不可能发生在同目录 rename） */
	private async writeInternal(value: T): Promise<void> {
		const dir = dirname(this.path);
		await mkdir(dir, { recursive: true });
		const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
		try {
			await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: this.mode });
			await rename(tmp, this.path);
		} catch (err) {
			await rm(tmp, { force: true }).catch(() => {});
			throw err;
		}
	}

	private writeInternalSync(value: T): void {
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true });
		const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
		try {
			writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: this.mode });
			renameSync(tmp, this.path);
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
	}

	/** 读取：缺失/损坏回退 default（损坏记 warn），其他 IO 错误上抛 */
	async read(): Promise<T> {
		try {
			const result = await this.readRaw();
			if (result.kind === "corrupted") {
				log.warn("json 文件损坏，read 回退默认值", this.path, result.error);
				return this.defaultValue();
			}
			return result.value;
		} catch (err) {
			log.warn("json 文件读取失败，read 回退默认值", this.path, err);
			return this.defaultValue();
		}
	}

	readSync(): T {
		try {
			const result = this.readRawSync();
			if (result.kind === "corrupted") {
				log.warn("json 文件损坏，readSync 回退默认值", this.path, result.error);
				return this.defaultValue();
			}
			return result.value;
		} catch (err) {
			log.warn("json 文件读取失败，readSync 回退默认值", this.path, err);
			return this.defaultValue();
		}
	}

	/**
	 * 读改写（串行化）：损坏抛 `JsonStoreCorruptedError`；mutator 可原地改 draft 或返回替换值。
	 * 返回最终写入的值。
	 */
	async update(mutator: (draft: T) => T | void): Promise<T> {
		return enqueue(this.path, async () => {
			const result = await this.readRaw();
			if (result.kind === "corrupted") throw new JsonStoreCorruptedError(this.path, result.error);
			let value = result.value;
			const replacement = mutator(value);
			if (replacement !== undefined) value = replacement;
			await this.writeInternal(value);
			return value;
		});
	}

	updateSync(mutator: (draft: T) => T | void): T {
		const result = this.readRawSync();
		if (result.kind === "corrupted") throw new JsonStoreCorruptedError(this.path, result.error);
		let value = result.value;
		const replacement = mutator(value);
		if (replacement !== undefined) value = replacement;
		this.writeInternalSync(value);
		return value;
	}

	/** 全量写入（调用方保证 value 是完整真相；同路径与其他 update/write 串行） */
	async write(value: T): Promise<void> {
		return enqueue(this.path, () => this.writeInternal(value));
	}

	writeSync(value: T): void {
		this.writeInternalSync(value);
	}

	/**
	 * 实例无持有资源（队列在模块级、settle 后自动清理），dispose 为契约占位：
	 * 供未来加 watcher/句柄时对齐调用方生命周期，当前调用是安全的 no-op。
	 */
	dispose(): void {}
}
