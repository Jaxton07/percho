import type { ReactNode } from "react";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { MessageItem } from "./MessageItem";
import { MetaGroup, type MetaItem } from "./MetaGroup";

/**
 * 中央消息流：最大宽度 760px 居中。
 * 合并规则：assistant 消息的思考/工具全部并入一个折叠组，正文（text）是边界——
 * 正文出现时组关闭、正文作为独立块渲染（与 working 定义一致：用户消息 → 下一次正文之间）。
 */
export function MessageList() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));
	/** agent 运行中且正文未出现（用户消息 → 下一次正文回复之间）→ 折叠组标题 working */
	const agentWorking = transcript.agentActive && !transcript.streaming?.text;

	const items: ReactNode[] = [];
	let metaItems: MetaItem[] = [];
	/** 组序号：key 按位置稳定（streaming→committed 转换不 remount，正文边界后的新组自增） */
	let groupIndex = 0;
	/**
	 * isLatest：是否为当前 run 的组（仅最后一个组接收 working 信号，历史组恒为已完成）
	 * forceEmpty：agent 工作中即使无内容也渲染（占位与流式组一体：空组 = 工作中 + 思考中预览）
	 */
	const flushMeta = (isLatest = false, forceEmpty = false) => {
		if (metaItems.length === 0 && !forceEmpty) return;
		// 正文在输出 → 工作组强制结束（streaming 里残留的 thinking/tools 不延长工作中）
		const endByText = Boolean(transcript.streaming?.text);
		items.push(
			<MetaGroup
				key={`meta-g${groupIndex++}`}
				items={metaItems}
				working={isLatest && agentWorking}
				endByText={endByText}
			/>,
		);
		metaItems = [];
	};

	for (const message of transcript.messages) {
		if (message.kind !== "assistant") {
			flushMeta();
			items.push(<MessageItem key={message.id} message={message} />);
			continue;
		}
		// 思考/工具（含正文消息自带的）全部进当前组
		if (message.thinking || message.tools.length > 0) {
			metaItems.push({ thinking: message.thinking, tools: message.tools });
		}
		// 正文是边界：组关闭，正文独立渲染（meta 已并入组）
		if (message.text) {
			flushMeta();
			items.push(<MessageItem key={message.id} message={message} metaInGroup />);
		}
	}
	if (transcript.streaming) {
		const streaming = transcript.streaming;
		if (streaming.thinking || streaming.tools.length > 0) {
			metaItems.push({
				thinking: streaming.thinking,
				tools: streaming.tools,
				activity: streaming.activity,
			});
		}
		if (streaming.text) {
			flushMeta();
			items.push(
				<MessageItem
					key="streaming"
					message={{
						kind: "assistant",
						id: "streaming",
						text: streaming.text,
						thinking: streaming.thinking,
						tools: streaming.tools,
						timestamp: Date.now(),
					}}
					streaming
					metaInGroup
				/>,
			);
		}
	}
	flushMeta(true, agentWorking);

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">{items}</div>
		</div>
	);
}
