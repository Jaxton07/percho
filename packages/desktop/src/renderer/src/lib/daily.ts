import { type EnvironmentRef, environmentEntityRef, environmentKey, LOCAL_ENVIRONMENT } from "@percho/shared";
import { getExecutionApi } from "../environment-api";

// Paths are renderer identities, not paths to use for local IO.
const dailyDirs = new Map<string, string>();

export async function initDailyDir(environment: EnvironmentRef = LOCAL_ENVIRONMENT): Promise<string | null> {
	const key = environmentKey(environment);
	const cached = dailyDirs.get(key);
	if (cached) return cached;
	try {
		const dir = await getExecutionApi(environment).getDailyDir();
		if (dir) dailyDirs.set(key, dir);
	} catch (error) {
		console.error("日常空间目录获取失败", error);
	}
	return dailyDirs.get(key) ?? null;
}

export function getDailyDirCached(environment: EnvironmentRef = LOCAL_ENVIRONMENT): string | null {
	return dailyDirs.get(environmentKey(environment)) ?? null;
}

export function getDailyDirsCached(): string[] {
	return [...dailyDirs.values()];
}

export function isDailyCwd(cwd: string | null | undefined): boolean {
	return typeof cwd === "string" && getDailyDirCached(environmentEntityRef(cwd).environment) === cwd;
}

export function setDailyDirForTest(
	dir: string | null,
	environment: EnvironmentRef = LOCAL_ENVIRONMENT,
): void {
	const key = environmentKey(environment);
	if (dir === null) dailyDirs.delete(key);
	else dailyDirs.set(key, dir);
}

/** Restore only previously known environment directory identities; no filesystem access. */
export function rememberDailyDirectory(cwd: string): void {
	dailyDirs.set(environmentKey(environmentEntityRef(cwd).environment), cwd);
}
