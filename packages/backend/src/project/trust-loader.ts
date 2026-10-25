import type { InlineExtension, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../log";
import type { PermissionConfirm, PermissionModeRef } from "../permissions/extension";
import { bindComposerInputBridge, createComposerInputBridge } from "../session/composer-input";
import { builtinExtensions } from "./builtin-extensions";
import { resolveProjectTrust, type TrustOptionInternal } from "./trust";

const log = createLogger("backend");

/**
 * 内置扩展注册顺序（**这段顺序就是语义，别调换**）：同组内**先注册者赢**
 * （`getAllRegisteredTools()` 里 `if (!toolsByName.has(name)) set(…)`）——所以我们先、官方内置后，
 * 我们（权限门控 / 蒸发 / todo-reminder / channel-watch）才能赢同名。
 * 另一面：我们**不**标 `replaceable`，官方三个内置都标了 —— 将来官方内置若真与我们同名
 * （如 1.1 加了官方 `todo`），被 `omitReplacedExtensions` 挤出局的是官方那个，不是我们。
 * 有单测锁这条顺序（`test/builtin-extensions.test.ts`）。
 */
export function composeExtensionFactories(
	ours: InlineExtension[],
	deps: { openUrl?: (url: string) => void | Promise<void> },
): InlineExtension[] {
	return [...ours, ...builtinExtensions(deps)];
}

/** 内置扩展注册编排（cwd + 会话的 confirm 通道 + 权限模式引用拼装 todo-reminder/权限门控/视觉代理；开关逻辑在调用方） */
export type ExtensionFactoryBuilder = (
	cwd: string,
	confirm: PermissionConfirm | undefined,
	modeRef?: PermissionModeRef,
) => InlineExtension[];

/**
 * 项目额外目录的提示段落（**措辞就是行为契约，改它等于改模型行为**）：空列表 → undefined（不注入）。
 * 只做声明，不做沙箱、不做多根资源发现（spec：pi 没有沙箱层，cwd 不变）。
 */
export function extraDirsPrompt(dirs: string[]): string | undefined {
	if (dirs.length === 0) return undefined;
	return ["项目还有这些目录（不在 cwd 内，需要时用绝对路径访问）：", ...dirs.map((dir) => `- ${dir}`)].join(
		"\n",
	);
}

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
			/** 桌面端集成：提示段落与 SDK 发现的 APPEND_SYSTEM.md 合并，额外技能目录透传。 */
			desktopIntegration?: {
				appendSystemPrompt: string[];
				additionalSkillPaths: string[];
			};
			/** 官方内置扩展（codemode/tool-search/mcp）的 OAuth 授权页打开方式（桌面端 = shell.openExternal） */
			openUrl?: (url: string) => void | Promise<void>;
			/** 按 cwd 返回项目额外目录（桌面端从 ui-state 读；缺省/返回空数组则不注入段落） */
			projectExtraDirs?: (cwd: string) => string[];
		},
	) {}

	/**
	 * 两阶段加载。askTrust=false 时信任未决按不信任处理（不弹窗）：draft 拉斜杠命令等
	 * 只读场景用，弹窗已在选目录时经 ensureTrust 前置。
	 */
	async load(
		cwd: string,
		options?: { askTrust?: boolean; confirm?: PermissionConfirm; modeRef?: PermissionModeRef },
	): Promise<{
		settingsManager: SettingsManager;
		resourceLoader: DefaultResourceLoader;
	}> {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const composer = createComposerInputBridge();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				...composeExtensionFactories(this.deps.buildExtensions(cwd, options?.confirm, options?.modeRef), {
					openUrl: this.deps.openUrl,
				}),
				composer.extension,
			],
			additionalSkillPaths: this.deps.desktopIntegration?.additionalSkillPaths,
			// appendSystemPrompt 会替换文件发现；override 在发现后合并，保留 SDK 信任/优先级规则。
			// 顺序：桌面端静态段落 → 项目额外目录声明（按 cwd 现取）→ SDK 发现的 APPEND_SYSTEM 段落。
			appendSystemPromptOverride: (base) => {
				const extraDirs = extraDirsPrompt(this.deps.projectExtraDirs?.(cwd) ?? []);
				return [
					...(this.deps.desktopIntegration?.appendSystemPrompt ?? []),
					...(extraDirs ? [extraDirs] : []),
					...base,
				];
			},
		});
		bindComposerInputBridge(resourceLoader, composer);
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
