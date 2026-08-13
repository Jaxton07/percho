import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

// 开发/预览态隔离 pi 用户数据：正式态与 CLI 共享 ~/.pi/agent，dev 直接跑会污染
// 正式 sessions 与配置。SDK getAgentDir() 最优先读 PI_CODING_AGENT_DIR（每次调用
// 实时读取、无缓存），在 main 入口最早设置即全链路生效（sessions/auth/models/
// trust/permissions/skills 全部派生自它）。必须早于 backend 的任何路径解析
// （index.ts 顶部 side-effect import，与 pi-package-dir 同模式）。
// 用户显式设置了 PI_CODING_AGENT_DIR 时尊重之，不做任何处理。
if (!app.isPackaged) {
	// dev 与正式版 app 名相同（@percho/desktop），userData 默认同目录，
	// tabs.json/ui-state.json/Local Storage 会被正式版污染（顶栏恢复出正式会话）。
	// 重定向到 -dev 后缀目录，app ready 前调用才生效。
	const devUserData = `${app.getPath("userData")}-dev`;
	app.setPath("userData", devUserData);
	mkdirSync(devUserData, { recursive: true });
	console.log(`[dev-agent-dir] userData=${devUserData}（与正式版 userData 隔离）`);
}

if (!app.isPackaged && !process.env.PI_CODING_AGENT_DIR) {
	const devDir = join(homedir(), ".pi", "agent-dev");
	const prodDir = join(homedir(), ".pi", "agent");
	process.env.PI_CODING_AGENT_DIR = devDir;
	mkdirSync(devDir, { recursive: true });
	// 一次性种子拷贝（只读正式、只写 dev，目标已存在跳过，之后两边互不影响）：
	// 无凭证/模型 dev 起不来；settings/permissions/trust 拷过去免去重复配置。
	// 目录类资源（skills/extensions/themes/prompts）不拷，dev 独立发展。
	for (const name of ["auth.json", "models.json", "settings.json", "permissions.json", "trust.json"]) {
		const src = join(prodDir, name);
		const dest = join(devDir, name);
		try {
			if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
		} catch {
			// 种子拷贝失败不阻断启动
		}
	}
	console.log(`[dev-agent-dir] PI_CODING_AGENT_DIR=${devDir}（与正式 ~/.pi/agent 隔离）`);
}
