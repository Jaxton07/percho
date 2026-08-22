import type { SessionEvent, TrustRequest } from "@percho/shared";
import { useEffect, useState } from "react";
import { getPi } from "./api";
import { EmptyState } from "./components/chat/EmptyState";
import { MessageList } from "./components/chat/MessageList";
import { TodoPanel } from "./components/chat/TodoPanel";
import { ProjectPage } from "./components/projects/ProjectPage";
import { ApprovalDock } from "./components/session/ApprovalDock";
import { SessionRail } from "./components/session/SessionRail";
import { SessionTabBar } from "./components/session/SessionTabBar";
import { TrustDialog } from "./components/session/TrustDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { useI18nStore } from "./i18n";
import { initUiPlugins } from "./plugins/loader";
import { RegionHost } from "./plugins/RegionHost";
import { Slot } from "./plugins/Slot";
import { UI_REGIONS, UI_SLOTS } from "./plugins/slots";
import { finishSplash } from "./splash";
import { useSessionsStore } from "./stores/sessions";
import { backgroundImageUrl, useThemeStore } from "./stores/theme";
import { useTranscriptStore } from "./stores/transcript";
import { messagesToUIMessages } from "./stores/transcript-reducer";
import { useUiStore } from "./stores/ui";
import { initUpdateStore } from "./stores/update";

/**
 * per-session 事件处理串行链（D4）：`compaction_end` 先 `getSessionMessages` 重建消息列表
 * 再 applyEvent，期间同会话后续事件若先被 apply 会以旧消息流渲染 → 回跳；链尾追加、
 * 空则删，保证同会话事件严格按到达顺序应用（compaction 的 try/catch 保留）。
 */
const eventChains = new Map<string, Promise<void>>();

function enqueueEvent(sessionId: string, run: () => Promise<void>): void {
	const prev = eventChains.get(sessionId) ?? Promise.resolve();
	const next = prev.then(run, run); // 链上错误已被吞，两分支等价；链尾追加保证顺序
	const settled = next.then(
		() => {},
		() => {},
	);
	eventChains.set(sessionId, settled);
	void settled.then(() => {
		if (eventChains.get(sessionId) === settled) eventChains.delete(sessionId); // 空链回收，防 Map 无界增长
	});
}

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const view = useUiStore((s) => s.view);
	const transcript = useTranscriptStore((s) => (activeSessionId ? s.bySession[activeSessionId] : undefined));
	const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);
	const language = useI18nStore((s) => s.language);

	// 视觉代理识别描述语言跟随界面语言（启动 + 切语言时推送 backend）
	useEffect(() => {
		void getPi().setVisionLanguage(language);
	}, [language]);

	useEffect(() => {
		const pi = getPi();
		const offEvent = pi.onEvent(({ sessionId, event }: { sessionId: string; event: SessionEvent }) => {
			enqueueEvent(sessionId, async () => {
				// 压缩成功后 pi 内部消息被裁剪，重新拉取对齐 UI 消息流
				if (event.type === "compaction_end" && !event.aborted && event.result) {
					try {
						const history = await pi.getSessionMessages(sessionId);
						useTranscriptStore.getState().loadHistory(sessionId, messagesToUIMessages(history));
					} catch {
						// 拉取失败不阻塞事件应用
					}
				}
				useTranscriptStore.getState().applyEvent(sessionId, event, {
					// 正被查看（活跃 tab 且 chat 视图）的会话完成时不打未读标记
					isActiveViewing:
						useSessionsStore.getState().activeSessionId === sessionId &&
						useUiStore.getState().view === "chat",
				});
				if (event.type === "session_info_changed") {
					useSessionsStore.getState().updateSessionName(sessionId, event.name);
				}
			});
		});
		const offPermission = pi.onPermissionRequest((req) => {
			useTranscriptStore.getState().addPermission(req.sessionId, req);
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
			offPermission();
			offTrust();
		};
	}, []);

	const respondTrust = (requestId: string, optionIndex: number) => {
		void getPi().respondTrust(requestId, optionIndex);
		setTrustRequests((prev) => prev.filter((req) => req.id !== requestId));
	};

	const showEmpty = !transcript || (transcript.messages.length === 0 && !transcript.streaming);
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
					   否则输入框（ApprovalDock）高度变化会压缩 main，轨道垂直居中随之漂移 */
					<div className="relative flex min-h-0 flex-1 flex-col">
						<main className="relative min-h-0 flex-1">
							{showEmpty ? <EmptyState /> : <MessageList />}
							<Slot name={UI_SLOTS.TodoPanel} props={{}} fallback={TodoPanel} />
							{/* 聊天区四角贡献层（top-right 与 TodoPanel 同角，容器已预留 pt-12） */}
							<RegionHost region={UI_REGIONS.CornerTopLeft} />
							<RegionHost region={UI_REGIONS.CornerTopRight} />
							<RegionHost region={UI_REGIONS.CornerBottomLeft} />
							<RegionHost region={UI_REGIONS.CornerBottomRight} />
						</main>
						<ApprovalDock sessionId={activeSessionId} hideComposer={showEmpty} />
						<SessionRail />
					</div>
				)}
			</div>
			{/* 悬浮贡献层：内容列之后、设置弹窗之前（z-20 < z-40，插件层永在弹窗之下） */}
			<RegionHost region={UI_REGIONS.AppOverlay} />
			<SettingsDialog />
			<TrustDialog requests={trustRequests} onRespond={respondTrust} />
		</div>
	);
}
