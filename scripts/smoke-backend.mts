// 冒烟测试：真实调用 pi SDK 验证 createSession/prompt/事件流（非自动化测试）
import { PiBackend } from "../packages/backend/src/index.ts";

async function main() {
  const backend = new PiBackend({ defaultCwd: "/tmp", projectTrust: false });
  await backend.init();

  const models = await backend.listModels();
  console.log("available models:", models.map((m) => `${m.provider}/${m.id}`).join(", "));

  const events: string[] = [];
  backend.onEvent((sessionId, event) => {
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (e.type === "text_delta") process.stdout.write(e.delta);
      if (e.type === "toolcall_start") console.log(`\n[TOOL] ${JSON.stringify(e.partial).slice(0, 200)}`);
    } else if (event.type === "tool_execution_start") {
      console.log(`\n[EXEC] ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
    } else if (event.type === "agent_end") {
      console.log(`\n[AGENT_END] willRetry=${event.willRetry}`);
    }
    events.push(event.type);
    void sessionId;
  });

  const meta = await backend.createSession({ cwd: "/tmp" });
  console.log(`\n[session] ${meta.sessionId} model=${meta.modelLabel}`);

  await backend.prompt(meta.sessionId, "用一句话回答：1+1 等于几？不要使用任何工具。");
  console.log("\n[prompt done]");

  console.log("event types seen:", [...new Set(events)].join(", "));
  const stats = await backend.getStats(meta.sessionId);
  console.log("stats:", JSON.stringify(stats));
  await backend.closeSession(meta.sessionId);
  backend.dispose();
}

void main();
