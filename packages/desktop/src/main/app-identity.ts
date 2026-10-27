import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import channels from "../../build/app-channels.json";

// 打包通道只取随包元数据，避免环境变量把正式版伪装成内测版或反过来。
const metadata = app.isPackaged
	? (JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
			releaseChannel?: unknown;
		})
	: null;
if (metadata?.releaseChannel !== undefined && !["stable", "beta"].includes(String(metadata.releaseChannel)))
	throw new Error("Invalid packaged release channel");
export const releaseChannel = !app.isPackaged
	? "dev"
	: metadata?.releaseChannel === "beta"
		? "beta"
		: "stable";
export const appIdentity = channels[releaseChannel];
export const supportsUpdates = app.isPackaged && releaseChannel === "stable";

// 正式版与已有开发目录保持兼容；自定义 --user-data-dir 也仍由调用方指定。
export function configureAppIdentity(): void {
	const userData = app.getPath("userData");
	app.setName(appIdentity.name);
	if (releaseChannel === "dev") app.setPath("userData", `${userData}-dev`);
	if (releaseChannel === "beta") {
		const custom = app.commandLine.getSwitchValue("user-data-dir");
		app.setPath("userData", custom || join(app.getPath("appData"), appIdentity.name));
	}
	if (process.platform === "win32") app.setAppUserModelId(appIdentity.appId);
}
