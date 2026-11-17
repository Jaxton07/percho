#!/usr/bin/env node
/** Numeric-only report from private CDP samples. Usage: node scripts/report-session-rendering.mjs baseline-prod [after-prod] */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { suiteRoot } from "./performance/paths.mjs";

const root = suiteRoot(
	resolve(import.meta.dirname, ".."),
	"rendering",
	".local/tmp/session-rendering-baseline",
	"PERCHO_RENDERING_ROOT",
);
const args = process.argv.slice(2);
const rootOption = args.find((value) => value.startsWith("--root="));
if (rootOption && resolve(rootOption.slice(7)) !== root)
	throw new Error("Report root does not match performance root");
const quantile = (values, q) => {
	const ordered = [...values].sort((a, b) => a - b);
	return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * q) - 1)] ?? 0;
};
const range = (values) => `${Math.min(...values).toFixed(1)}–${Math.max(...values).toFixed(1)}`;
const reports = [];
for (const label of args.filter((value) => value !== rootOption)) {
	assert.match(label, /^[a-z-]+$/);
	const report = JSON.parse(await readFile(resolve(root, `${label}.json`), "utf8"));
	const lines = [
		`### ${label}`,
		`构建：${report.buildMode}；合成事件：${report.eventCount}。输入数值为 CDP 输入往返至下一次 rAF 的时间，包含协议开销，不代表 OS 已呈现。`,
		"",
		"| 阶段 | 次数 | 工具数 | 元素数 | 帧间隔p95范围(ms) | 长任务次数范围 | 长任务总时长范围(ms) | 堆使用范围(MiB) | 输入样本(ms) |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const stage of [...new Set(report.samples.map((s) => s.stage))]) {
		const samples = report.samples.filter((s) => s.stage === stage),
			inputs = samples.flatMap((s) => s.inputs);
		lines.push(
			`| ${stage} | ${samples.length} | ${range(samples.map((s) => s.tools))} | ${range(samples.map((s) => s.elements))} | ${range(samples.map((s) => quantile(s.frames, 0.95)))} | ${range(samples.map((s) => s.longTasks.length))} | ${range(samples.map((s) => s.longTasks.reduce((n, t) => n + t, 0)))} | ${range(samples.map((s) => s.metrics.JSHeapUsedSize / 1048576))} | ${inputs.length ? `${inputs.length}个，${range(inputs)}` : "—"} |`,
		);
	}
	lines.push(
		"",
		"窗口口径：" +
			JSON.stringify([
				...new Set(report.samples.map((s) => `${s.width}×${s.height}, DPR=${s.dpr}, hidden=${s.hidden}`)),
			]),
		"",
		"增长阶段通过500事件/秒的短突发构造，批次之间等待界面接收，包含背压，不能用其总耗时比较固定速率吞吐。steady-50 阶段各投递150事件、固定50事件/秒，是流式帧和输入的主要比较窗口。local-history-mount 为直接装载的局部归因；backend-history-open 为实际历史读取及安装路径，两个口径分开。",
		"",
		"DOM元素为当前文档查询；Memory.getDOMCounters还可能包含等待GC的脱离节点，不能直接当泄漏。堆为CDP JSHeapUsedSize，未强制GC，不等于进程工作集。长任务按超过50ms统计，此值不是验收门槛。输入样本少，报告范围，不估算可靠p95。",
		"",
		...report.samples
			.filter((s) => s.openRoundTripMs !== undefined)
			.map(
				(s) =>
					`历史打开第${s.round + 1}次：${s.openRoundTripMs.toFixed(1)}ms（CDP往返至两次rAF，不等于图片解码或物理冷盘）。`,
			),
	);
	reports.push(lines.join("\n"));
}
const output = reports.join("\n\n");
await writeFile(resolve(root, "metrics-report.md"), output);
console.log(output);
