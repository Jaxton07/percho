import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 日常空间工作台目录（~/.percho/daily）：全部日常会话的固定 cwd，与 ~/.percho/ui-plugins 同级。
 * 信任链：目录无 .pi/ 与 .agents/skills 资源 → hasTrustRequiringProjectResources 为 false，
 * 建会话自动信任、不弹信任框。dev/预览态与正式版共享此目录（仅工作区，会话列表按
 * PI_CODING_AGENT_DIR 天然隔离，互不污染）。
 */
export function getDailyDir(): string {
	return join(homedir(), ".percho", "daily");
}

/** 懒创建（幂等）后返回目录；IPC 下发给 renderer 前统一走这里 */
export async function ensureDailyDir(): Promise<string> {
	const dir = getDailyDir();
	await mkdir(dir, { recursive: true });
	return dir;
}
