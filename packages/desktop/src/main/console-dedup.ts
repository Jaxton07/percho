/**
 * renderer console 错误签名去重（spec log-trace-hardening 决策 4）。
 *
 * 事故实录：monaco UNKNOWN service 一天 1005 条近似重复错误把主日志灌到 MB 级，
 * 真信号被稀释。规则：签名 = message 前 200 字符 + sourceId；首次全量落盘，
 * 重复内存计数不落盘；距上次落盘增量 ≥ threshold（10）立即出一条汇总行，
 * 周期 flush 补慢烧场景（增量 1..threshold-1 的签名每周期一条）。
 * 签名表 FIFO 上限 256（Map 迭代序 = 插入序，删最旧），防恶意循环撑爆。
 */

export interface ConsoleDedupSummary {
	/** 命中的签名（截断前） */
	signature: string;
	/** 自上一条全量/汇总以来的新增条数 */
	sinceLast: number;
	/** 该签名累计总条数 */
	total: number;
}

export interface ConsoleDedupDecision {
	/** true = 该签名首次出现，调用方照常全量落盘 */
	logFull: boolean;
	/** 突发汇总（增量已达阈值） */
	summary?: ConsoleDedupSummary;
}

/** 签名：message 前 200 字符 + sourceId（monaco 类错误 message 含完整堆栈，200 字符足以区分簇） */
export function consoleSignature(message: string, sourceId?: string): string {
	return `${message.slice(0, 200)}|${sourceId ?? ""}`;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_THRESHOLD = 10;

export function createConsoleDeduper(options?: { maxEntries?: number; threshold?: number }) {
	const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
	const entries = new Map<string, { count: number; lastLoggedCount: number }>();

	return {
		observe(signature: string): ConsoleDedupDecision {
			const entry = entries.get(signature);
			if (!entry) {
				if (entries.size >= maxEntries) {
					// FIFO 淘汰：Map 迭代序 = 插入序，删最旧（被逐出的签名再现时按首条落盘）
					const oldest = entries.keys().next().value;
					if (oldest !== undefined) entries.delete(oldest);
				}
				entries.set(signature, { count: 1, lastLoggedCount: 0 });
				return { logFull: true };
			}
			entry.count++;
			const sinceLast = entry.count - entry.lastLoggedCount;
			if (sinceLast < threshold) return { logFull: false };
			entry.lastLoggedCount = entry.count;
			return { logFull: false, summary: { signature, sinceLast, total: entry.count } };
		},

		/** 周期 flush（60s，unref timer 驱动）：慢烧场景补汇总——增量不足阈值的签名也出一条 */
		flush(): ConsoleDedupSummary[] {
			const out: ConsoleDedupSummary[] = [];
			for (const [signature, entry] of entries) {
				const sinceLast = entry.count - entry.lastLoggedCount;
				if (sinceLast < 1) continue;
				entry.lastLoggedCount = entry.count;
				out.push({ signature, sinceLast, total: entry.count });
			}
			return out;
		},
	};
}

export type ConsoleDeduper = ReturnType<typeof createConsoleDeduper>;

/** 汇总行的日志参数（message + args，与既有 renderer console 行风格一致） */
export function consoleDedupLogLine(
	s: ConsoleDedupSummary,
): [message: string, args: Record<string, unknown>] {
	return [
		"renderer console repeated",
		{ count: s.total, sinceLast: s.sinceLast, signature: s.signature.slice(0, 100) },
	];
}
