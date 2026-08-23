import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type CompressionState, createInitialState } from "acp-kernel";
import { createLogger } from "../../log";

const log = createLogger("acp-store");

/**
 * ACP state 旁路文件（T2，spec D5）：`<sessionFile>.acp.json`，tmp+rename 原子写。
 * 损坏/写失败一律降级（回退初始 state / 只 log），绝不阻塞会话。
 * fork 继承：沿会话文件首行 header.parentSession 链找最近的非空 state（链深上限 8）。
 */

const STATE_SUFFIX = ".acp.json";
const PARENT_CHAIN_LIMIT = 8;

/** 持久化形状 = kernel CompressionState + Percho 版本戳（格式演进预留） */
export interface PersistedAcpState extends CompressionState {
	version: number;
}

export const ACP_STATE_VERSION = 1;

export function acpStateFile(sessionFile: string | undefined | null): string | null {
	return sessionFile ? sessionFile + STATE_SUFFIX : null;
}

/** 校验 + 补全持久化形状；不可恢复的形状返回 null（调用方回退初始 state） */
export function hydrateAcpState(parsed: unknown): CompressionState | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const raw = parsed as Partial<CompressionState> & { version?: unknown };
	if (!Array.isArray(raw.blocks) || typeof raw.blocks[0] !== "object") {
		// blocks 允许为空数组，但必须是数组
		if (!Array.isArray(raw.blocks)) return null;
	}
	if (
		typeof raw.messageRefs !== "object" ||
		raw.messageRefs === null ||
		typeof raw.messageRefs.byRaw !== "object" ||
		typeof raw.messageRefs.byRef !== "object"
	) {
		return null;
	}
	const base = createInitialState();
	return {
		...base,
		...raw,
		blocks: [...raw.blocks],
		messageRefs: {
			byRaw: { ...raw.messageRefs.byRaw },
			byRef: { ...raw.messageRefs.byRef },
		},
		tokenSnapshot: { ...(raw.tokenSnapshot ?? {}) },
		nudge: { ...base.nudge, ...(raw.nudge ?? {}), anchors: { ...(raw.nudge?.anchors ?? {}) } },
		stats: { ...base.stats, ...(raw.stats ?? {}) },
	};
}

async function readStateFile(file: string): Promise<CompressionState | null> {
	try {
		const raw = await readFile(file, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const state = hydrateAcpState(parsed);
		if (!state) {
			log.warn("acp state 形状无效，回退初始 state", { file });
		}
		return state;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("acp state 读取失败，回退初始 state", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return null;
	}
}

/** 读会话文件首行 header 的 parentSession 路径（fork 链）；不存在/损坏返回 undefined */
async function readParentSessionPath(sessionFile: string): Promise<string | undefined> {
	try {
		const handle = await open(sessionFile, "r");
		try {
			const buf = Buffer.alloc(65536);
			const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
			if (bytesRead === 0) return undefined;
			const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
			if (!firstLine.startsWith("{")) return undefined;
			const header = JSON.parse(firstLine) as { parentSession?: unknown };
			return typeof header.parentSession === "string" ? header.parentSession : undefined;
		} finally {
			await handle.close();
		}
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== "ENOENT") {
			log.warn("会话 header 读取失败（fork 继承跳过）", {
				sessionFile,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return undefined;
	}
}

/** 加载 state：本会话文件 →（空时）沿 fork 父链继承 → 初始 state。损坏一律降级不阻塞。 */
export async function loadAcpState(sessionFile: string | undefined | null): Promise<CompressionState> {
	const file = acpStateFile(sessionFile);
	if (!file) return createInitialState();
	const own = await readStateFile(file);
	// 本会话 state 文件存在（哪怕块为空）就以它为准——曾显式重置的会话不重新继承父链；
	// 只有文件不存在时才走 fork 继承
	if (own) return own;
	// 无本会话 state 文件 → fork 继承
	let current: string | undefined = sessionFile ?? undefined;
	for (let depth = 0; depth < PARENT_CHAIN_LIMIT && current; depth++) {
		const parentJsonl = await readParentSessionPath(current);
		if (!parentJsonl) return createInitialState();
		const parentAcp = acpStateFile(parentJsonl);
		if (!parentAcp) return createInitialState();
		const parentState = await readStateFile(parentAcp);
		if (parentState && parentState.blocks.length > 0) {
			log.info("acp state 从 fork 父会话继承", { parentAcp, depth, blocks: parentState.blocks.length });
			return parentState;
		}
		current = parentJsonl;
	}
	return createInitialState();
}

/** 原子写 state（tmp+rename）；失败只 log 不抛（内存态继续，会话不阻塞）。无 sessionFile 时 no-op。 */
export async function saveAcpState(
	sessionFile: string | undefined | null,
	state: CompressionState,
): Promise<void> {
	const file = acpStateFile(sessionFile);
	if (!file) return;
	const payload: PersistedAcpState = { version: ACP_STATE_VERSION, ...state };
	try {
		const dir = dirname(file);
		await mkdir(dir, { recursive: true });
		const tmp = join(dir, `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
		try {
			await writeFile(tmp, JSON.stringify(payload), "utf8");
			await rename(tmp, file);
		} catch (err) {
			await rm(tmp, { force: true }).catch(() => {});
			throw err;
		}
	} catch (err) {
		log.error("acp state 写入失败（内存态继续）", {
			file,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** 重置（SDK compaction 后 ref 映射大面积失效，spec D2）：删旁路文件；ENOENT 静默。 */
export async function resetAcpState(sessionFile: string | undefined | null): Promise<void> {
	const file = acpStateFile(sessionFile);
	if (!file) return;
	try {
		await rm(file, { force: true });
	} catch (err) {
		log.warn("acp state 删除失败", {
			file,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
