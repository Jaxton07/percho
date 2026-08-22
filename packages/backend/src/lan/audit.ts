import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * LAN 写操作审计日志（spec D7/§6.4）：jsonl 追加写，记录时间/客户端 IP/动作/目标/结果，
 * 绝不记 token。超 1MB 截断头部保留尾部 512KB（tmp+rename 原子替换）。
 * 量极小（人工点击速率），同步 IO 即可。
 */
const MAX_BYTES = 1024 * 1024;
const KEEP_TAIL_BYTES = 512 * 1024;

export interface LanAuditEntry {
	/** ISO 时间 */
	t: string;
	/** 客户端 IP（socket remoteAddress） */
	ip: string;
	/** 动作：prompt / abort / perm */
	action: string;
	/** 目标：sessionId 或 requestId */
	target: string;
	/** 结果：ok / denied / error（+ 简述，如 read_only / bad_answer / 上游错误首行） */
	result: string;
}

export class LanAuditLog {
	constructor(private readonly path: string) {}

	record(entry: LanAuditEntry): void {
		try {
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
			this.truncateIfNeeded();
		} catch {
			// 审计失败不阻塞业务（与 P1「日志不落 token」同级：宁缺审计不断服务）
		}
	}

	private truncateIfNeeded(): void {
		try {
			const size = statSync(this.path).size;
			if (size <= MAX_BYTES) return;
			const content = readFileSync(this.path, "utf8");
			const tail = content.slice(-KEEP_TAIL_BYTES);
			// 切到下一个换行符，避免半行
			const clean = tail.slice(tail.indexOf("\n") + 1);
			const tmp = `${this.path}.tmp`;
			writeFileSync(tmp, clean, "utf8");
			renameSync(tmp, this.path);
		} catch {
			// 截断失败下一轮再试
		}
	}
}
