import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** pi 无自动命名逻辑：第一条用户消息到达即取首行作为会话标题（不等 agent_end，顶栏标题即时更新） */
export function autoNameSession(session: AgentSession, event: AgentSessionEvent): void {
	if (event.type !== "message_start") return;
	if (session.sessionManager.getSessionName()) return;
	const message = event.message;
	if (message.role !== "user") return;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((p) => p.type === "text")
					.map((p) => ("text" in p ? p.text : ""))
					.join(" ");
	const firstLine = (text.trim().split("\n")[0] ?? "").trim();
	if (!firstLine) return;
	session.setSessionName(firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine);
}
