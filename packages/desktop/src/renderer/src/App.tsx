import type { SessionEvent, TrustRequest } from "@percho/shared";
import { useEffect, useState } from "react";
import { getPi } from "./api";
import { EmptyState } from "./components/chat/EmptyState";
import { MessageList } from "./components/chat/MessageList";
import { TodoPanel } from "./components/chat/TodoPanel";
import { DiffSidebar } from "./components/diff/DiffSidebar";
import { ProjectPage } from "./components/projects/ProjectPage";
import { ApprovalDock } from "./components/session/ApprovalDock";
import { BranchBadge } from "./components/session/BranchBadge";
import { SessionRail } from "./components/session/SessionRail";
import { SessionTabBar } from "./components/session/SessionTabBar";
import { TrustDialog } from "./components/session/TrustDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { Toaster } from "./components/Toaster";
import { useI18nStore } from "./i18n";
import { initUiPlugins } from "./plugins/loader";
import { RegionHost } from "./plugins/RegionHost";
import { Slot } from "./plugins/Slot";
import { UI_REGIONS, UI_SLOTS } from "./plugins/slots";
import { finishSplash } from "./splash";
import { EventConflator } from "./stores/event-conflator";
import { useSessionsStore } from "./stores/sessions";
import { backgroundImageUrl, useThemeStore } from "./stores/theme";
import { useTranscriptStore } from "./stores/transcript";
import { useUiStore } from "./stores/ui";
import { initUpdateStore } from "./stores/update";

/**
 * 压缩后 UI 历史保留：SDK compaction 只裁剪 LLM 上下文（agent.state.messages），
 * 会话树 jsonl 完整；UI 消息流不再在 `compaction_end` 后用 getSessionMessages 整体
 * 重置（曾把 1334 条历史瞬间换成 662 条裁剪版），只让 reducer 追加分界线 system
 * 消息——历史/fork/recall 依旧基于完整分支。
 */

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const view = useUiStore((s) => s.view);
	// 订阅收敛为原始值（selector 返回 boolean → 仅在值翻转时重渲染）：App 子树（TabBar/MessageList/
	// TodoPanel/DiffSidebar/…）无 memo，若订阅 transcript 对象会随每条流式 delta 全量级联重渲染
	const showEmpty = useTranscriptStore((s) => {
		const entry = activeSessionId ? s.bySession[activeSessionId] : undefined;
		return !entry || (entry.messages.length === 0 && !entry.streaming);
	});
	const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);
	const language = useI18nStore((s) => s.language);

	// 视觉代理识别描述语言跟随界面语言（启动 + 切语言时推送 backend）
	useEffect(() => {
		void getPi().setVisionLanguage(language);
	}, [language]);

	useEffect(() => {
		const pi = getPi();
		// 流式 delta 按帧合流（见 stores/event-conflator.ts）：store 提交频率 ≤ 1 次/帧，
		// 边界事件（message_start/end、toolcall_start/end、turn_end、agent_end…）先冲刷挂起增量
		// 再立即应用，顺序与逐条转发完全一致。isActiveViewing 在应用时刻取值：延迟至多一帧且
		// 该标记只在 agentActive 翻转的边界事件上生效（不经过合流），语义不变
		const conflator = new EventConflator({
			apply: (sessionId, event) => {
				useTranscriptStore.getState().applyEvent(sessionId, event, {
					// 正被查看（活跃 tab 且 chat 视图）的会话完成时不打未读标记
					isActiveViewing:
						useSessionsStore.getState().activeSessionId === sessionId &&
						useUiStore.getState().view === "chat",
				});
			},
		});
		const offEvent = pi.onEvent(({ sessionId, event }: { sessionId: string; event: SessionEvent }) => {
			if (event.type === "session_info_changed") {
				useSessionsStore.getState().updateSessionName(sessionId, event.name);
				return; // 会话名走 sessions store；reducer 对该类型本就无操作
			}
			conflator.push(sessionId, event);
		});
		const offPermission = pi.onPermissionRequest((req) => {
			useTranscriptStore.getState().addPermission(req.sessionId, req);
		});
		const offPermissionResolved = pi.onPermissionResolved((result) => {
			useTranscriptStore.getState().resolvePermission(result.sessionId, result.requestId);
		});
		const offTrust = pi.onTrustRequest((req) => {
			setTrustRequests((prev) => [...prev, req]);
		});
		// 开屏就绪信号：首批数据（模型列表 + 恢复标签页）settle 后绽放收場（finishSplash 幂等）
		void Promise.allSettled([
			useSessionsStore.getState().loadModels(),
			useSessionsStore.getState().restoreTabs(),
		]).then(() => finishSplash());
		initUpdateStore();
		// UI 插件加载链路（总开关关时只订阅事件，零开销）
		void initUiPlugins();
		return () => {
			offEvent();
			conflator.dispose();
			offPermission();
			offPermissionResolved();
			offTrust();
		};
	}, []);

	const respondTrust = (requestId: string, optionIndex: number) => {
		void getPi().respondTrust(requestId, optionIndex);
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
				<SessionTabBar />
				{view === "projects" ? (
					<div className="min-h-0 flex-1">
						<ProjectPage />
					</div>
				) : (
					/* SessionRail 以整列（tab bar 以下全视口）为定位基准：不在 main 内，
					   否则输入框（ApprovalDock）高度变化会压缩 main，轨道垂直居中随之漂移。
					   外层 flex-row：末尾挂 DiffSidebar（push 式，聊天列自然压缩） */
					<div className="relative flex min-h-0 flex-1">
						<div className="relative flex min-w-0 flex-1 flex-col">
							<main className="relative min-h-0 flex-1">
								{showEmpty ? <EmptyState /> : <MessageList />}
								<Slot name={UI_SLOTS.TodoPanel} props={{}} fallback={TodoPanel} />
								<BranchBadge />
								{/* 聊天区四角贡献层（top-right 与 TodoPanel 同角，容器已预留 pt-12） */}
								<RegionHost region={UI_REGIONS.CornerTopLeft} />
								<RegionHost region={UI_REGIONS.CornerTopRight} />
								<RegionHost region={UI_REGIONS.CornerBottomLeft} />
								<RegionHost region={UI_REGIONS.CornerBottomRight} />
							</main>
							<ApprovalDock sessionId={activeSessionId} hideComposer={showEmpty} />
							<SessionRail />
						</div>
						<DiffSidebar />
					</div>
				)}
			</div>
			{/* 悬浮贡献层：内容列之后、设置弹窗之前（z-20 < z-40，插件层永在弹窗之下） */}
			<RegionHost region={UI_REGIONS.AppOverlay} />
			<SettingsDialog />
			<TrustDialog requests={trustRequests} onRespond={respondTrust} />
			<Toaster />
		</div>
	);
}
