import type { TrustRequest } from "@percho/shared";
import { environmentEntityRef, LOCAL_ENVIRONMENT } from "@percho/shared";
import { useCallback, useEffect, useRef } from "react";
import { getPi } from "./api";
import { CornerStack } from "./components/chat/CornerStack";
import { EmptyState } from "./components/chat/EmptyState";
import { MessageList } from "./components/chat/MessageList";
import { SubagentBackButton } from "./components/chat/SubagentBackButton";
import { TodoPanel } from "./components/chat/TodoPanel";
import { DiffSidebar } from "./components/diff/DiffSidebar";
import { RemoteAttentionBanner } from "./components/remote/RemoteAttentionBanner";
import { RemoteConnectionDialog } from "./components/remote/RemoteConnectionDialog";
import { DockSlot } from "./components/session/DockSlot";
import { SessionRail } from "./components/session/SessionRail";
import { SessionTabBar } from "./components/session/SessionTabBar";
import { TrustDialog } from "./components/session/TrustDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { Sidebar } from "./components/sidebar/Sidebar";
import { Toaster } from "./components/Toaster";
import { getExecutionApi } from "./environment-api";
import { useSessionEventBridge } from "./hooks/use-session-event-bridge";
import { useI18nStore } from "./i18n";
import { selectActiveCwd } from "./lib/active-cwd";
import { initDailyDir } from "./lib/daily";
import { useSessionGc } from "./lib/use-session-gc";
import { initUiPlugins } from "./plugins/loader";
import { RegionHost } from "./plugins/RegionHost";
import { Slot } from "./plugins/Slot";
import { UI_REGIONS, UI_SLOTS } from "./plugins/slots";
import { finishSplash } from "./splash";
import { initAppQuit } from "./stores/app-quit";
import {
	initChannelSubscriptions,
	invalidateChannelSubscriptionQueries,
	syncActiveSession,
} from "./stores/channel-subscriptions";
import { startEnvironmentUiPersistence } from "./stores/environment-ui-restore";
import { useInteractionStore } from "./stores/interactions";
import { initRemoteConnectionBridge } from "./stores/remote-connection";
import { restoreSessionWorkspace } from "./stores/session-workspace-restore";
import { useSessionsStore } from "./stores/sessions";
import { useHasParentRelation } from "./stores/subagent-return";
import { initTaskNotificationNavigation } from "./stores/task-notification-navigation";
import { backgroundImageUrl, useThemeStore } from "./stores/theme";
import { useTranscriptStore } from "./stores/transcript";
import { useUiPreferencesStore } from "./stores/ui-preferences";
import { initUpdateStore } from "./stores/update";

/**
 * 压缩后 UI 历史保留：SDK compaction 只裁剪 LLM 上下文（agent.state.messages），
 * 会话树 jsonl 完整；UI 消息流不再在 `compaction_end` 后用 getSessionMessages 整体
 * 重置（曾把 1334 条历史瞬间换成 662 条裁剪版），只让 reducer 追加分界线 system
 * 消息——历史/fork/recall 依旧基于完整分支。
 */

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// 子代理检视页才挂返回入口：无关系时连左上定位容器都不出现（不留占位）
	const hasParentRelation = useHasParentRelation(activeSessionId);
	/** Todo 槽位的 `display: contents` 宿主：CornerStack 靠它测量渲染根底边（插件原绝对定位不受影响） */
	const todoSlotHostRef = useRef<HTMLDivElement | null>(null);
	// 频道订阅快照（spec D1）：**先建立事件订阅**（声明在前 ⇒ 同一提交内先执行），再按活动会话取一次快照；
	// reload/启动恢复靠这条查询自恢复，不依赖曾收到事件
	useEffect(() => initChannelSubscriptions(), []);
	useEffect(() => {
		void syncActiveSession(activeSessionId);
		// cleanup（卸载 / 依赖变化 / StrictMode 重跑）让这一次的在途查询作废
		return invalidateChannelSubscriptionQueries;
	}, [activeSessionId]);
	// 订阅收敛为原始值（selector 返回 boolean → 仅在值翻转时重渲染）：App 子树（TabBar/MessageList/
	// TodoPanel/DiffSidebar/…）无 memo，若订阅 transcript 对象会随每条流式 delta 全量级联重渲染
	const showEmpty = useTranscriptStore((s) => {
		const entry = activeSessionId ? s.bySession[activeSessionId] : undefined;
		return !entry || (entry.messages.length === 0 && !entry.streaming);
	});
	const trustRequests = useInteractionStore((state) => state.trustRequests);
	const selectedTrustId = useInteractionStore((state) => state.selectedTrustId);
	const activeCwd = useSessionsStore(selectActiveCwd);
	const foregroundTrustCwd = useInteractionStore((state) => state.foregroundTrustCwd);
	const visibleTrustRequests = trustRequests.filter(
		(request) =>
			environmentEntityRef(request.id).environment.kind === "local" ||
			request.id === selectedTrustId ||
			request.cwd === activeCwd ||
			request.cwd === foregroundTrustCwd,
	);

	// 事件桥：conflator 装配 + 事件/权限/信任订阅（回调稳定引用，桥只订阅一次不重挂）
	const pushTrustRequest = useCallback((req: TrustRequest) => {
		useInteractionStore.getState().addTrust(req);
	}, []);
	useSessionEventBridge({ onTrustRequest: pushTrustRequest });

	// 一次性 bootstrap：开屏就绪信号 + 更新状态 + UI 插件加载
	// 会话内存策略（K=3 热会话 + 受保护不卸）：全局挂一次，策略细节在 lib/session-gc.ts
	useSessionGc();
	useEffect(() => initRemoteConnectionBridge(), []);
	useEffect(() => {
		const sync = () => {
			void getPi()
				.setNotificationLanguage({ language: useI18nStore.getState().language })
				.catch(() => {});
		};
		sync();
		return useI18nStore.subscribe(sync);
	}, []);

	useEffect(() => {
		// 上次项目目录：启动即预填（用户不用重选项目）。**只带 cwd，不恢复任何会话**——
		// v10 启动仍是纯空会话页，历史全在左栏。偏好已在 main.tsx render 前 init 完毕，这里同步可用。
		// 单例 draft：开屏就建好唯一那份（cwd = lastCwd，模型等 loadModels 回填），
		// 这样「空态输入框 / 项目选择器 / 发送」从一开始就有同一份配置真相
		const lastCwd = useUiPreferencesStore.getState().lastCwd;
		useSessionsStore.getState().activateNewSessionDraft(lastCwd ?? undefined);
		// 开屏就绪信号：首批数据（模型列表）settle 后收场（finishSplash 幂等）。
		// v10：**不再恢复上次打开的会话**（启动纯空 = 新会话页，与 pi 原生 / Codex 一致）；
		// 历史全在左栏，点一下才按需加载
		void Promise.allSettled([useSessionsStore.getState().loadModels(LOCAL_ENVIRONMENT)]).then(() =>
			finishSplash(),
		);
		// 后台恢复工作区成员与顺序；历史内容只在用户点击会话时加载。
		void restoreSessionWorkspace().finally(startEnvironmentUiPersistence);
		initUpdateStore();
		// 退出确认（Windows）：挂载即向 main 声明接管，点 ✕ 才会拦下来弹窗
		initAppQuit();
		// 日常空间目录缓存（pill/轨道/侧栏的空间归属判定依赖；失败静默，入口退化为不显示）
		void initDailyDir();
		// UI 插件加载链路（总开关关时只订阅事件，零开销）
		void initUiPlugins();
	}, []);

	useEffect(() => initTaskNotificationNavigation(), []);
	const respondTrust = async (requestId: string, optionIndex: number) => {
		await getExecutionApi(requestId).respondTrust({ requestId, answer: optionIndex });
		useInteractionStore.getState().removeTrust(requestId);
	};

	const bgImage = useThemeStore((s) => s.background.image);
	const bgDim = useThemeStore((s) => s.background.dim);

	return (
		<div className="relative h-full">
			{bgImage && (
				<>
					<div className="app-bg" style={{ backgroundImage: `url("${backgroundImageUrl(bgImage)}")` }} />
					<div className="app-bg-scrim" style={{ opacity: bgDim }} />
				</>
			)}
			{/* 背景贡献层：与自定义背景图同层同规则（z-0，界面默认不透明时不可见），内容列（z-10）之前 */}
			<RegionHost region={UI_REGIONS.AppBackground} />
			<div className="relative z-10 flex h-full flex-col">
				{/* 顶栏常驻（v9）：它承担窗口拖动 / 左栏开合 / 变更侧栏入口，不再整条隐藏；
				   设置里的开关只控制「是否显示置顶会话胶囊」（见 SessionTabBar） */}
				<SessionTabBar />
				<div className="relative flex min-h-0 flex-1">
					<Sidebar />
					{/* 聊天页容器：会话推/出过渡的动画主体（lib/session-page-slide.ts 认 data-session-page 找它，
					   用 data-session-id 判定「新内容已上屏」）。顶栏与左栏不在此容器内 ⇒ 导航时保持静态 */}
					<div
						className="relative flex min-w-0 flex-1 flex-col"
						data-session-page=""
						data-session-id={activeSessionId ?? ""}
					>
						{/* 左侧会话轨道（临时工作区）：挂在 main + DockSlot 的父容器上，定位基准是 tab bar 以下的整列内容区——
						    输入框高度变化不压缩它的居中参考系；收起态是纯覆盖层，不占宽、不挤压聊天布局（设置里默认关） */}
						<SessionRail />
						{/* 右侧 DiffSidebar 是独立浮层，不参与中间聊天列宽度与布局动画。 */}
						<main className="relative min-h-0 flex-1">
							{showEmpty ? <EmptyState /> : <MessageList />}
							{/* Todo 槽位宿主：display:contents 不产生盒子（插件/默认 Todo 的原绝对定位不受影响），
							    只给 CornerStack 一个可 observe 的挂载点（它去测量渲染根的实际底边） */}
							<div ref={todoSlotHostRef} style={{ display: "contents" }}>
								<Slot name={UI_SLOTS.TodoPanel} props={{}} fallback={TodoPanel} />
							</div>
							{/* 右上角：频道胶囊 + top-right 贡献共用一个堆叠（CornerStack），一起避开 Todo 实际底边；
							    top-left 用 leading 插返回父会话入口，与左上区域贡献共用同一定位容器 */}
							<CornerStack slotHostRef={todoSlotHostRef} />
							<RegionHost
								region={UI_REGIONS.CornerTopLeft}
								leading={hasParentRelation ? <SubagentBackButton /> : undefined}
							/>
							<RegionHost region={UI_REGIONS.CornerBottomLeft} />
							<RegionHost region={UI_REGIONS.CornerBottomRight} />
						</main>
						<DockSlot sessionId={activeSessionId} hideComposer={showEmpty} />
					</div>
					<DiffSidebar />
				</div>
			</div>
			{/* 悬浮贡献层：内容列之后、设置弹窗之前（z-20 < z-40，插件层永在弹窗之下） */}
			<RegionHost region={UI_REGIONS.AppOverlay} />
			<SettingsDialog />
			<RemoteConnectionDialog />
			<RemoteAttentionBanner />
			<TrustDialog requests={visibleTrustRequests} onRespond={respondTrust} />
			<Toaster />
		</div>
	);
}
