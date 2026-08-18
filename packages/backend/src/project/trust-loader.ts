import type { InlineExtension, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../log";
import type { PermissionConfirm } from "../permissions/extension";
import { resolveProjectTrust, type TrustOptionInternal } from "./trust";

const log = createLogger("backend");

/** 内置扩展注册编排（cwd + 会话的 confirm 通道拼装 todo-reminder/权限门控/视觉代理；开关逻辑在调用方） */
export type ExtensionFactoryBuilder = (
	cwd: string,
	confirm: PermissionConfirm | undefined,
) => InlineExtension[];

/**
 * 项目资源加载器（对齐 CLI main.js:533-570 的两阶段加载）：
 * 先 projectTrusted=false 只加载用户级资源 → 解析项目信任 → 按结果重载。
 * 不信任时项目级 settings/extensions/skills/prompts/themes 不加载。
 */
export class ProjectResourceLoader {
	constructor(
		private readonly deps: {
			trustStore: ProjectTrustStore;
			/** 信任未决时弹窗询问（TrustGate.ask） */
			ask: (cwd: string, options: TrustOptionInternal[]) => Promise<number | undefined>;
			/** 是否存在信任 UI 处理器（无 UI 时 ask 一律视为不信任） */
			canAsk: () => boolean;
			/** 按会话的 confirm 通道拼装内置扩展（开关逻辑在调用方） */
			buildExtensions: ExtensionFactoryBuilder;
			/** false 时所有项目自动信任（无人值守场景） */
			projectTrust?: boolean;
			/** 桌面端集成：追加系统提示词段落 + 额外技能目录（透传给 DefaultResourceLoader） */
			desktopIntegration?: {
				appendSystemPrompt: string[];
				additionalSkillPaths: string[];
			};
		},
	) {}

	/**
	 * 两阶段加载。askTrust=false 时信任未决按不信任处理（不弹窗）：draft 拉斜杠命令等
	 * 只读场景用，弹窗已在选目录时经 ensureTrust 前置。
	 */
	async load(
		cwd: string,
		options?: { askTrust?: boolean; confirm?: PermissionConfirm },
	): Promise<{
		settingsManager: SettingsManager;
		resourceLoader: DefaultResourceLoader;
	}> {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: this.deps.buildExtensions(cwd, options?.confirm),
			...this.deps.desktopIntegration,
		});
		if (this.deps.projectTrust === false) {
			settingsManager.setProjectTrusted(true);
			await resourceLoader.reload();
			return { settingsManager, resourceLoader };
		}
		await resourceLoader.reload({
			resolveProjectTrust: async () => {
				const trusted = await resolveProjectTrust({
					cwd,
					trustStore: this.deps.trustStore,
					defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
					askUser:
						options?.askTrust !== false && this.deps.canAsk()
							? (dir, opts) => this.deps.ask(dir, opts)
							: undefined,
				});
				log.info("project trust resolved", cwd, { trusted });
				return trusted;
			},
		});
		return { settingsManager, resourceLoader };
	}

	/**
	 * 项目信任前置决策（添加项目/切换 draft cwd 时由 renderer 调用）：未决则经
	 * TrustGate 弹窗，结果落 trust.json；此后 draft 拉命令与建会话都命中缓存，不再弹窗。
	 */
	async ensureTrust(cwd: string): Promise<boolean> {
		const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
		const trusted = await resolveProjectTrust({
			cwd,
			trustStore: this.deps.trustStore,
			defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
			askUser: this.deps.canAsk() ? (dir, o) => this.deps.ask(dir, o) : undefined,
		});
		log.info("project trust ensured", cwd, { trusted });
		return trusted;
	}
}
