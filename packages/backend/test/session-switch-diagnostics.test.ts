import { switchPercentile } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	beginSessionSwitchProbe,
	finishSessionSwitchProbe,
	measureSessionSwitch,
	recordSessionSwitchPayload,
} from "../src/session/switch-diagnostics";

afterEach(() => {
	finishSessionSwitchProbe();
});
describe("会话分段诊断", () => {
	it("默认不处理正文或改变运行；开启后只保留大小与固定阶段", () => {
		const payload = {
			toJSON() {
				throw new Error("must not serialize when disabled");
			},
		};
		expect(() => recordSessionSwitchPayload(payload)).not.toThrow();
		beginSessionSwitchProbe();
		const finish = measureSessionSwitch("sdkParse");
		finish();
		finish();
		recordSessionSwitchPayload({ secret: "SENSITIVE", path: "/private/test" });
		const result = finishSessionSwitchProbe();
		expect(result.stages).toHaveLength(1);
		expect(result.stages[0]?.milliseconds).toBeGreaterThanOrEqual(0);
		expect(result.payloadBytes).toBeGreaterThan(0);
		expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|private|secret/);
	});
	it("旧轮次的迟到计时不能写入新报告，样本有界", () => {
		beginSessionSwitchProbe();
		const old = measureSessionSwitch("runtime");
		beginSessionSwitchProbe();
		old();
		for (let i = 0; i < 200; i++) measureSessionSwitch("sdkParse")();
		expect(finishSessionSwitchProbe().stages).toHaveLength(128);
	});
	it("使用最近秩p50/p95，不修改原始样本", () => {
		const samples = [9, 1, 8, 2, 7, 3, 6, 4, 5, 10];
		expect(switchPercentile(samples, 0.5)).toBe(5);
		expect(switchPercentile(samples, 0.95)).toBe(10);
		expect(samples[0]).toBe(9);
		expect(switchPercentile([], 0.95)).toBeNull();
	});
});
