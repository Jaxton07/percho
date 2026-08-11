import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// SDK getPackageDir() 优先读 PI_PACKAGE_DIR：打包态把 docs/examples/README 等资源
// 经 extraResources 装到 resources/pi-package/（真实文件，agent 的 bash 也能访问）。
// 必须最先执行（index.ts 首行 import），早于 backend/SDK 的任何路径解析。
const dir = join(process.resourcesPath, "pi-package");
if (app.isPackaged && existsSync(dir)) {
	process.env.PI_PACKAGE_DIR = dir;
}
