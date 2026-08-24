// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nextUpdateAction, type UpdateActionState } from "./update-policy";

/** update-policy 纯函数测试：updater 检查/下载拆分（B1）的决策分支 */

function state(partial: Partial<UpdateActionState>): UpdateActionState {
	return { latestVersion: null, downloaded: false, manualInstall: false, ...partial };
}

describe("nextUpdateAction", () => {
	it("已发现新版且未下载 → 下载", () => {
		expect(nextUpdateAction(state({ latestVersion: "0.4.7" }))).toBe("download");
	});

	it("未发现新版 → 检查", () => {
		expect(nextUpdateAction(state({}))).toBe("check");
	});

	it("已下载 → 无操作（等用户点重启）", () => {
		expect(nextUpdateAction(state({ latestVersion: "0.4.7", downloaded: true }))).toBe("noop");
	});

	it("manual 构建（mac adhoc）即使发现新版也只重查，不下载", () => {
		expect(nextUpdateAction(state({ latestVersion: "0.4.7", manualInstall: true }))).toBe("check");
	});
});
