import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 权限模式审计日志（spec permission-mode D3）：fullAccess 档下「default 档本会被 ask/deny」
 * 的调用留痕，append-only JSONL。超 1MB 截断头部保留尾部 512KB（tmp+rename 原子替换）。
 * 高危命中频率 = 人工可审计量级，同步 IO 即可；写失败 catch 不阻塞工具调用（仿 lan/audit.ts）。
 */
const MAX_BYTES = 1024 * 1024;
const KEEP_TAIL_BYTES = 512 * 1024;

export interface PermissionAuditEntry {
	/** ISO 时间 */
	t: string;
	/** 会话 id（ctx.sessionManager 可达时标注；跨会话追溯用 cwd+时间亦够定位） */
	sessionId?: string;
	/** toolName（bash/edit/write/...） */
	tool: string;
	/** default 档下本会被如何处置 */
	action: "ask" | "deny";
	/** 匹配文本：bash=命中段，路径工具=resolve 后绝对路径（截断 500 字符，不脱敏——留痕即意义） */
	text: string;
	/** 会话项目根 */
	cwd?: string;
	/** 边界类触发来源（规则 ask/deny 无此字段） */
	boundary?: "outside-write" | "outside-read" | "temporary";
}

export function permissionAuditPath(agentDir: string): string {
	return join(agentDir, "permission-audit.jsonl");
}

export class PermissionAuditLog {
	constructor(private readonly path: string) {}

	record(entry: PermissionAuditEntry): void {
		try {
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
			this.truncateIfNeeded();
		} catch {
			// 审计失败不阻塞工具调用（宁缺审计不断会话）
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
