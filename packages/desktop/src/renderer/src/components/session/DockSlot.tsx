import { useTranscriptStore } from "../../stores/transcript";
import { Composer } from "../composer/Composer";
import { ApprovalDock } from "./ApprovalDock";
import { InteractionDock } from "./InteractionDock";

/**
 * 底部交换槽仲裁（D6）：权限审批 > 扩展对话框 > Composer。
 * 三者同位互换——agent 阻塞等答时发消息无意义；两种卡各自内部处理排队与退出动画，
 * 未上场的卡停在 store 队列里，前者应答后自动顶上。
 */
export function DockSlot({ sessionId, hideComposer }: { sessionId: string | null; hideComposer: boolean }) {
	// selector 返回引用/undefined（原始稳定），不订阅整条 transcript 防流式 delta 级联重渲染
	const permission = useTranscriptStore((s) =>
		sessionId ? s.bySession[sessionId]?.pendingPermissions[0] : undefined,
	);
	const dialog = useTranscriptStore((s) =>
		sessionId ? s.bySession[sessionId]?.pendingDialogs[0] : undefined,
	);
	if (permission) return <ApprovalDock sessionId={sessionId} />;
	if (dialog) return <InteractionDock sessionId={sessionId} />;
	if (hideComposer) return null;
	// relative z-20：× 删除键 -top-1.5 伸出容器顶 → 落入消息区，须盖过 MessageList 的 z-10
	return (
		<div className="approval-composer-enter relative z-20">
			<Composer />
		</div>
	);
}
