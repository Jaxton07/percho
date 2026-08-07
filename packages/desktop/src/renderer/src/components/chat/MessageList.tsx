import type { ReactNode } from "react";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { MessageItem } from "./MessageItem";
import { MetaGroup, type MetaItem } from "./MetaGroup";

/** 中央消息流：最大宽度 760px 居中；连续无正文的助手消息（思考/工具）合并为一个折叠组 */
export function MessageList() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));

	const items: ReactNode[] = [];
	let metaItems: MetaItem[] = [];
	let metaKey = "";
	const flushMeta = () => {
		if (metaItems.length === 0) return;
		items.push(<MetaGroup key={`meta-${metaKey}`} items={metaItems} />);
		metaItems = [];
		metaKey = "";
	};

	for (const message of transcript.messages) {
		const metaOnly =
			message.kind === "assistant" && !message.text && (message.thinking || message.tools.length > 0);
		if (metaOnly) {
			if (!metaKey) metaKey = message.id;
			metaItems.push({ thinking: message.thinking, tools: message.tools });
		} else {
			flushMeta();
			items.push(<MessageItem key={message.id} message={message} />);
		}
	}
	if (transcript.streaming) {
		const streaming = transcript.streaming;
		const metaOnly = !streaming.text && (streaming.thinking || streaming.tools.length > 0);
		if (metaOnly) {
			metaItems.push({ thinking: streaming.thinking, tools: streaming.tools, streaming: true });
		} else {
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
				/>,
			);
		}
	}
	flushMeta();

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">{items}</div>
		</div>
	);
}
