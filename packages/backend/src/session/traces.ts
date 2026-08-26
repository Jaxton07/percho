import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../log";
import { TraceRecorder } from "./trace";

const log = createLogger("backend");

/** 会话事件 trace 的生命周期管理（每会话一个 recorder，与会话同目录） */
export class SessionTraces {
	private readonly recorders = new Map<string, TraceRecorder>();

	/** 为会话建立 trace（与会话同目录）；失败只告警不中断 */
	async start(sessionId: string, sessionDir: string | undefined): Promise<void> {
		if (!sessionDir) return;
		try {
			const recorder = await TraceRecorder.create(sessionDir, sessionId);
			this.recorders.set(sessionId, recorder);
		} catch (err) {
			log.warn("trace create failed", sessionId, err);
		}
	}

	/** 事件落盘（emitEvent 分发前调用） */
	record(sessionId: string, event: AgentSessionEvent): void {
		this.recorders.get(sessionId)?.record(event);
	}

	/** 自定义观测行（合成 type=trace_custom；reducer 遇未知类型 no-op，replay 安全）。
	 *  不走 emitEvent → 不进 IPC/不进 UI——只落 trace 供灰度分析脚本直读（如蒸发批次） */
	recordCustom(sessionId: string, kind: string, data: unknown): void {
		this.recorders.get(sessionId)?.record({ type: "trace_custom", kind, data, ts: Date.now() });
	}

	/** 停止并落盘 trace */
	async stop(sessionId: string): Promise<void> {
		const recorder = this.recorders.get(sessionId);
		if (!recorder) return;
		this.recorders.delete(sessionId);
		await recorder.close();
	}

	/** 关闭全部（app 退出） */
	disposeAll(): void {
		for (const recorder of this.recorders.values()) {
			void recorder.close();
		}
		this.recorders.clear();
	}
}
