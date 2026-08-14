import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
	type DefaultProjectTrust,
	hasTrustRequiringProjectResources,
	type ProjectTrustStore,
	type ProjectTrustUpdate,
} from "@earendil-works/pi-coding-agent";
import type { TrustOption, TrustRequest } from "@percho/shared";

/** 信任选项（含写 trust.json 所需的 updates；key 发给 renderer 展示） */
export interface TrustOptionInternal {
	key: TrustOption["key"];
	trusted: boolean;
	updates: ProjectTrustUpdate[];
}

/** trust.json key 与 CLI 对齐：realpath 解析符号链接（如 macOS /tmp → /private/tmp） */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * 信任选项：刻意从 CLI 的五选项精简为两个（信任/不信任，均落 trust.json）。
 * 「仅本次」不落盘，在 draft 拉斜杠命令 + 建会话都要查信任的流程里语义会崩
 * （每次进入都重问）且场景极少；信任父目录可用直接选择上层目录替代。
 */
export function buildTrustOptions(cwd: string): TrustOptionInternal[] {
	const trustPath = canonicalize(resolve(cwd));
	return [
		{ key: "trust", trusted: true, updates: [{ path: trustPath, decision: true }] },
		{ key: "deny", trusted: false, updates: [{ path: trustPath, decision: false }] },
	];
}

export interface ResolveTrustOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	defaultProjectTrust: DefaultProjectTrust;
	/** 缺省（无 UI）时 ask 一律视为不信任，与 CLI print/json 模式一致 */
	askUser?: (cwd: string, options: TrustOptionInternal[]) => Promise<number | undefined>;
}

/**
 * 项目信任决策链，对齐 pi 的 resolveProjectTrusted（SDK 未导出，core/project-trust.js:17-58）。
 * 差异：CLI 支持 --approve 覆盖与扩展 project_trust 事件投票，桌面端无此两者。
 */
export async function resolveProjectTrust(options: ResolveTrustOptions): Promise<boolean> {
	const { cwd, trustStore, defaultProjectTrust, askUser } = options;
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const decision = trustStore.get(cwd);
	if (decision !== null) return decision;
	switch (defaultProjectTrust) {
		case "always":
			return true;
		case "never":
			return false;
	}
	if (!askUser) return false;
	const trustOptions = buildTrustOptions(cwd);
	const selected = await askUser(cwd, trustOptions);
	const option = selected === undefined ? undefined : trustOptions[selected];
	if (!option) return false;
	if (option.updates.length > 0) {
		trustStore.setMany(option.updates);
	}
	return option.trusted;
}

export type TrustResponder = (req: TrustRequest) => void;

let nextId = 0;

/**
 * 项目信任门控：决策需要用户输入时发 trust-request 事件并等待应答。
 * 应答为选项下标；用户关闭/取消（undefined）按不信任处理（与 CLI 一致）。
 */
export class TrustGate {
	private readonly pending = new Map<
		string,
		{ optionCount: number; resolve: (answer: number | undefined) => void }
	>();
	/** 同一 cwd 的在途询问去重：选目录预检与会话创建可能并发触发，避免同项目弹两次 */
	private readonly inflightByCwd = new Map<string, Promise<number | undefined>>();

	constructor(private readonly onRequest: TrustResponder) {}

	ask(cwd: string, options: TrustOptionInternal[]): Promise<number | undefined> {
		const inflight = this.inflightByCwd.get(cwd);
		if (inflight) return inflight;
		const id = `trust-${nextId++}`;
		const promise = new Promise<number | undefined>((resolve) => {
			this.pending.set(id, { optionCount: options.length, resolve });
			this.onRequest({
				id,
				cwd,
				options: options.map((o) => ({ key: o.key })),
			});
		});
		this.inflightByCwd.set(cwd, promise);
		void promise.then(() => this.inflightByCwd.delete(cwd));
		return promise;
	}

	respond(requestId: string, answer: number): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		this.pending.delete(requestId);
		if (!Number.isInteger(answer) || answer < 0 || answer >= entry.optionCount) {
			entry.resolve(undefined);
			return;
		}
		entry.resolve(answer);
	}

	dispose(): void {
		for (const entry of this.pending.values()) entry.resolve(undefined);
		this.pending.clear();
		this.inflightByCwd.clear();
	}
}
