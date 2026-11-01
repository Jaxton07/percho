import type { SessionSwitchProbe, SessionSwitchStage } from "@percho/shared";

/** 单次显式隔离诊断；只记录固定阶段和数值，绝不接收路径/正文。关闭时不序列化载荷。 */
let recording: SessionSwitchProbe | null = null;
export function beginSessionSwitchProbe(): void {
	recording = { stages: [], payloadBytes: 0 };
}
export function finishSessionSwitchProbe(): SessionSwitchProbe {
	const result = recording ?? { stages: [], payloadBytes: 0 };
	recording = null;
	return result;
}
export function measureSessionSwitch(stage: SessionSwitchStage): () => void {
	const target = recording;
	if (!target) return () => {};
	const start = performance.now();
	let finished = false;
	return () => {
		if (finished || recording !== target) return;
		finished = true;
		if (target.stages.length < 128) target.stages.push({ stage, milliseconds: performance.now() - start });
	};
}
export function recordSessionSwitchPayload(value: unknown): void {
	const target = recording;
	if (!target) return;
	const start = performance.now();
	target.payloadBytes = Buffer.byteLength(JSON.stringify(value));
	target.payloadAccountingMs = performance.now() - start;
}
