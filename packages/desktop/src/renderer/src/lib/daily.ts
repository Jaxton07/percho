import { getPi } from "../api";

/**
 * 日常空间目录的 renderer 侧缓存：App 启动时 init 一次，之后同步读。
 * 日常空间 = 固定工作台 cwd（main 侧 ~/.percho/daily，懒创建），所有日常会话按 cwd 归属该空间；
 * 项目页/空态/胶囊统一经 isDailyCwd 判定，不在各处散落路径字符串。
 */
let dailyDir: string | null = null;

/** 拉取并缓存日常目录（幂等；失败静默回退 null，日常入口退化为不显示） */
export async function initDailyDir(): Promise<string | null> {
	if (dailyDir) return dailyDir;
	try {
		dailyDir = await getPi().getDailyDir();
	} catch (error) {
		console.error("日常空间目录获取失败", error);
	}
	return dailyDir;
}

export function getDailyDirCached(): string | null {
	return dailyDir;
}

export function isDailyCwd(cwd: string | null | undefined): boolean {
	return typeof cwd === "string" && dailyDir !== null && cwd === dailyDir;
}

/** 测试注入用（deriveProjects 等纯函数依赖模块缓存，单测先 set 再断言） */
export function setDailyDirForTest(dir: string | null): void {
	dailyDir = dir;
}
