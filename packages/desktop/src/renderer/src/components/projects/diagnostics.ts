import type { SessionMeta } from "@percho/shared";

/**
 * 会话诊断信息文本（spec log-trace-hardening 决策 6）：纯文本，用户一键复制直接贴给
 * agent 排查用。全部数据 renderer 已有（SessionMeta + preload 暴露的静态信息），无新 IPC。
 * traceFile 由 sessionFile 推导（不保证存在——内存会话/未落盘也照写，排查时 ls 一下即知）。
 */
export function buildDiagnosticsText(
	session: Pick<SessionMeta, "sessionId" | "sessionFile" | "name">,
	info: { platform: string; appVersion: string },
): string {
	const sessionFile = session.sessionFile ?? "(内存会话)";
	const dir = sessionFile.includes("/") ? sessionFile.slice(0, sessionFile.lastIndexOf("/")) : "";
	const traceFile = dir ? `${dir}/traces/trace-${session.sessionId}.jsonl` : "(内存会话)";
	return [
		"Percho 诊断信息",
		`sessionId: ${session.sessionId}`,
		`name: ${session.name ?? "(未命名)"}`,
		`sessionFile: ${sessionFile}`,
		`traceFile: ${traceFile}`,
		`appVersion: ${info.appVersion}`,
		`platform: ${info.platform}`,
	].join("\n");
}
