export const SESSION_SWITCH_STAGES = [
	"sdkParse",
	"sourceParse",
	"runtime",
	"resourceLoad",
	"createSession",
	"bindExtensions",
	"historyProjection",
] as const;
export type SessionSwitchStage = (typeof SESSION_SWITCH_STAGES)[number];
export interface SessionSwitchMeasurement {
	stage: SessionSwitchStage;
	milliseconds: number;
}
export interface SessionSwitchFixture {
	name: "screenshots" | "text" | "long-text" | "large-turn" | "branches";
	file: string;
	bytes: number;
}
export interface SessionSwitchProbe {
	stages: SessionSwitchMeasurement[];
	payloadBytes: number;
	/** JSON字节计数本身的开销；包含在诊断往返中，不能当作产品固有成本。 */
	payloadAccountingMs?: number;
	source?: { views: number; metadata: number; parses: number; peakViews: number };
}
export function switchPercentile(values: readonly number[], percentile: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1))] ?? null;
}
