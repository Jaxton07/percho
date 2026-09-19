import type { TrustRequest } from "@percho/shared";
import { useCallback, useEffect, useState } from "react";
import { getPi } from "./api";
import { EmptyState } from "./components/chat/EmptyState";
import { MessageList } from "./components/chat/MessageList";
import { TodoPanel } from "./components/chat/TodoPanel";
import { DiffSidebar } from "./components/diff/DiffSidebar";
import { DockSlot } from "./components/session/DockSlot";
import { SessionTabBar } from "./components/session/SessionTabBar";
import { TrustDialog } from "./components/session/TrustDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { Sidebar } from "./components/sidebar/Sidebar";
import { Toaster } from "./components/Toaster";
import { useSessionEventBridge } from "./hooks/use-session-event-bridge";
import { initDailyDir } from "./lib/daily";
import { initUiPlugins } from "./plugins/loader";
import { RegionHost } from "./plugins/RegionHost";
import { Slot } from "./plugins/Slot";
import { UI_REGIONS, UI_SLOTS } from "./plugins/slots";
import { finishSplash } from "./splash";
import { useSessionsStore } from "./stores/sessions";
import { backgroundImageUrl, useThemeStore } from "./stores/theme";
import { useTranscriptStore } from "./stores/transcript";
import { initUpdateStore } from "./stores/update";

/**
 * 压缩后 UI 历史保留：SDK compaction 只裁剪 LLM 上下文（agent.state.messages），
 * 会话树 jsonl 完整；UI 消息流不再在 `compaction_end` 后用 getSessionMessages 整体
 * 重置（曾把 1334 条历史瞬间换成 662 条裁剪版），只让 reducer 追加分界线 system
 * 消息——历史/fork/recall 依旧基于完整分支。
 */

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// 订阅收敛为原始值（selector 返回 boolean → 仅在值翻转时重渲染）：App 子树（TabBar/MessageList/
	// TodoPanel/DiffSidebar/…）无 memo，若订阅 transcript 对象会随每条流式 delta 全量级联重渲染
	const showEmpty = useTranscriptStore((s) => {
		const entry = activeSessionId ? s.bySession[activeSessionId] : undefined;
		return !entry || (entry.messages.length === 0 && !entry.streaming);
	});
	const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);

	// 事件桥：conflator 装配 + 事件/权限/信任订阅（回调稳定引用，桥只订阅一次不重挂）
	const pushTrustRequest = useCallback((req: TrustRequest) => {
		setTrustRequests((prev) => [...prev, req]);
	}, []);
	useSessionEventBridge({ onTrustRequest: pushTrustRequest });

	// 一次性 bootstrap：开屏就绪信号 + 更新状态 + UI 插件加载
	useEffect(() => {
		// 开屏就绪信号：首批数据（模型列表）settle 后收场（finishSplash 幂等）。
		// v10：**不再恢复上次打开的会话**（启动纯空 = 新会话页，与 pi 原生 / Codex 一致）；
		// 历史全在左栏，点一下才按需加载
		void Promise.allSettled([useSessionsStore.getState().loadModels()]).then(() => finishSplash());
		initUpdateStore();
		// 日常空间目录缓存（pill/轨道/侧栏的空间归属判定依赖；失败静默，入口退化为不显示）
		void initDailyDir();
		// UI 插件加载链路（总开关关时只订阅事件，零开销）
		void initUiPlugins();
	}, []);

	const respondTrust = (requestId: string, optionIndex: number) => {
		void getPi().respondTrust({ requestId, answer: optionIndex });
		setTrustRequests((prev) => prev.filter((req) => req.id !== requestId));
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
					<div className="relative flex min-w-0 flex-1 flex-col">
						{/* 中间列保底 380 = 宽度账本（画板 C），右栏挤不下时已由 DiffSidebar 自己转浮层 */}
						<main className="relative min-h-0 flex-1">
							{showEmpty ? <EmptyState /> : <MessageList />}
							<Slot name={UI_SLOTS.TodoPanel} props={{}} fallback={TodoPanel} />
							{/* 聊天区四角贡献层（top-right 与 TodoPanel 同角，容器已预留 pt-12） */}
							<RegionHost region={UI_REGIONS.CornerTopLeft} />
							<RegionHost region={UI_REGIONS.CornerTopRight} />
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
			<TrustDialog requests={trustRequests} onRespond={respondTrust} />
			<Toaster />
		</div>
	);
}
