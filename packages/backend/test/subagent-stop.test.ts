import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";
import type { SubagentRunHandle } from "../src/tools/subagent/runner";

describe("子代理停止路由", () => {
	it("运行实例优先于只读副本；只中止目标；退出清理其余实例", async () => {
		const backend = new PiBackend();
		const internal = backend as unknown as {
			runningSubagents: Map<string, SubagentRunHandle>;
			registry: SessionRegistry;
		};
		const child = () => ({ abort: vi.fn(async () => {}), dispose: vi.fn(), getBranch: () => [] });
		const first = child(),
			second = child();
		internal.runningSubagents.set("first", first);
		internal.runningSubagents.set("second", second);
		const readOnlyAbort = vi.fn();
		vi.spyOn(internal.registry, "get").mockReturnValue({
			session: { abort: readOnlyAbort },
			readOnly: true,
		} as never);
		await backend.abort("first");
		expect(first.abort).toHaveBeenCalledOnce();
		expect(second.abort).not.toHaveBeenCalled();
		expect(readOnlyAbort).not.toHaveBeenCalled();
		internal.runningSubagents.delete("first");
		backend.dispose();
		await vi.waitFor(() => expect(second.dispose).toHaveBeenCalledOnce());
		expect(second.abort).toHaveBeenCalledOnce();
	});
});
