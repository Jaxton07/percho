/** 更新诊断状态；未观察到目标版本启动 ≠ 已证实安装失败。 */
export interface UpdateDiagnosticsInfo {
	previousInstall: "none" | "unconfirmed" | "target-running" | "version-changed";
	targetVersion: string | null;
}
