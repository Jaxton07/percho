import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** pi 无自动命名逻辑：首轮 agent_end 后取第一条用户消息首行作为会话标题 */
export function autoNameSession(session: AgentSession, event: AgentSessionEvent): void {
	if (event.type !== "agent_end") return;
	if (session.sessionManager.getSessionName()) return;
	const firstUser = session.agent.state.messages.find((m) => m.role === "user");
	if (!firstUser) return;
	const text =
		typeof firstUser.content === "string"
			? firstUser.content
			: firstUser.content
					.filter((p) => p.type === "text")
					.map((p) => ("text" in p ? p.text : ""))
					.join(" ");
	const firstLine = (text.trim().split("\n")[0] ?? "").trim();
	if (!firstLine) return;
	session.setSessionName(firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine);
}
