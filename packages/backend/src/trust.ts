import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	type DefaultProjectTrust,
	hasTrustRequiringProjectResources,
	type ProjectTrustStore,
	type ProjectTrustUpdate,
} from "@earendil-works/pi-coding-agent";
import type { TrustOption, TrustRequest } from "@percho/shared";

/** 信任选项（含写 trust.json 所需的 updates；key/parentPath 发给 renderer 展示） */
export interface TrustOptionInternal {
	key: TrustOption["key"];
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	parentPath?: string;
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
 * 复刻 pi 的 getProjectTrustOptions（SDK 未导出，core/trust-manager.js:38-67）。
 * 选项与顺序保持 CLI 一致：信任 / 信任父目录 / 仅本次信任 / 不信任 / 仅本次不信任。
 */
export function buildTrustOptions(cwd: string): TrustOptionInternal[] {
	const trustPath = canonicalize(resolve(cwd));
	const options: TrustOptionInternal[] = [
		{ key: "trust", trusted: true, updates: [{ path: trustPath, decision: true }] },
	];
	const parentPath = dirname(trustPath);
	if (parentPath !== trustPath) {
		options.push({
			key: "trustParent",
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			parentPath,
		});
	}
	options.push({ key: "trustSession", trusted: true, updates: [] });
	options.push({ key: "deny", trusted: false, updates: [{ path: trustPath, decision: false }] });
	options.push({ key: "denySession", trusted: false, updates: [] });
	return options;
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

	constructor(private readonly onRequest: TrustResponder) {}

	ask(cwd: string, options: TrustOptionInternal[]): Promise<number | undefined> {
		const id = `trust-${nextId++}`;
		return new Promise<number | undefined>((resolve) => {
			this.pending.set(id, { optionCount: options.length, resolve });
			this.onRequest({
				id,
				cwd,
				options: options.map((o) => ({ key: o.key, parentPath: o.parentPath })),
			});
		});
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
	}
}
