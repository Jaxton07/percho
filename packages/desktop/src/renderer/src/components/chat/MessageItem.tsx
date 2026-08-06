import { memo } from "react";
import type { UIMessage } from "../../stores/transcript";
import { AssistantMessage } from "./AssistantMessage";

/** 单条消息：按类型分发（用户气泡 / 错误 / 助手消息体） */
export const MessageItem = memo(function MessageItem({
	message,
	streaming,
}: {
	message: UIMessage;
	streaming?: boolean;
}) {
	if (message.kind === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-900 px-3.5 py-2 text-[14px] leading-relaxed text-white select-text">
					{message.text}
				</div>
			</div>
		);
	}

	if (message.kind === "error") {
		return (
			<div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600 select-text">
				{message.text}
			</div>
		);
	}

	return (
		<AssistantMessage
			text={message.text}
			thinking={message.thinking}
			tools={message.tools}
			streaming={streaming}
		/>
	);
});
