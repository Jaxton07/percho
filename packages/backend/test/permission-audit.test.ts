import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionAuditLog, permissionAuditPath } from "../src/permissions/audit";

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-perm-audit-"));
}

function entry(tool: string, text: string) {
	return { t: "2026-09-07T00:00:00.000Z", tool, action: "ask" as const, text };
}

describe("PermissionAuditLog", () => {
	it("record 追加 JSONL 行", () => {
		const dir = makeDir();
		const log = new PermissionAuditLog(permissionAuditPath(dir));
		log.record(entry("bash", "rm -rf /tmp/x"));
		log.record({ ...entry("write", "/etc/hosts"), boundary: "outside-write" });
		const lines = readFileSync(permissionAuditPath(dir), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ tool: "bash", action: "ask", text: "rm -rf /tmp/x" });
		expect(JSON.parse(lines[1] ?? "")).toMatchObject({ tool: "write", boundary: "outside-write" });
	});

	it("超 1MB 截断头部保留尾部 512KB（完整行）", () => {
		const dir = makeDir();
		const path = permissionAuditPath(dir);
		// 预置 >1MB 文件（大 text 块），末行是标记行；一次 record 触发截断
		const big = "x".repeat(2048);
		const rows: string[] = [];
		for (let i = 0; i < 600; i++) {
			rows.push(JSON.stringify(entry("bash", `${big} #${i}`)));
		}
		rows.push(JSON.stringify(entry("bash", "TAIL-MARKER")));
		writeFileSync(path, `${rows.join("\n")}\n`, "utf8");
		const log = new PermissionAuditLog(path);
		log.record(entry("bash", "after-truncate"));
		const content = readFileSync(path, "utf8");
		expect(content.length).toBeLessThan(600 * 1024);
		// 首行完整（无半行）
		const first = content.split("\n")[0] ?? "";
		expect(() => JSON.parse(first)).not.toThrow();
		// 尾部标记行保留，新行在末尾
		expect(content).toContain("TAIL-MARKER");
		expect(content.trimEnd().endsWith(JSON.stringify(entry("bash", "after-truncate")))).toBe(true);
	});

	it("目录不存在/不可写不抛（审计失败不阻塞工具调用）", () => {
		const log = new PermissionAuditLog(join(makeDir(), "no-such-dir", "audit.jsonl"));
		expect(() => log.record(entry("bash", "x"))).not.toThrow();
		expect(existsSync(join("no-such-dir"))).toBe(false);
	});
});
