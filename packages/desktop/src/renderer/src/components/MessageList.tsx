import { useSessionsStore } from "../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../stores/transcript";
import { MessageItem } from "./MessageItem";

/** 中央消息流：最大宽度 760px 居中 */
export function MessageList() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">
				{transcript.messages.map((message) => (
					<MessageItem key={message.id} message={message} />
				))}
				{transcript.streaming && (
					<MessageItem
						message={{
							kind: "assistant",
							id: "streaming",
							text: transcript.streaming.text,
							thinking: transcript.streaming.thinking,
							tools: transcript.streaming.tools,
							timestamp: Date.now(),
						}}
						streaming
					/>
				)}
			</div>
		</div>
	);
}
