import {
	LOCAL_ENVIRONMENT,
	SESSION_SWITCH_STAGES,
	type SessionSwitchProbe,
	switchPercentile,
} from "@percho/shared";
import { getPi } from "../api";
import { thumbnailService } from "../components/chat/history-image/history-image-service";
import { imageReader } from "../components/chat/history-image/image-reader";
import { getExecutionApi } from "../environment-api";
import { isHistoryReady } from "../stores/session-history";
import { useSessionsStore } from "../stores/sessions";
import { useLocalSettingsStore } from "../stores/settings";
import { beginRendererSwitchProbe, finishRendererSwitchProbe } from "./session-switch-probe";
import { assertSwitchResourceBudget, assertSwitchResourcesReleased } from "./session-switch-resource-check";

let running = false;
/** 与界面共用真实导航/IPC链路；不注入模型、不发送任务，不修改扩展或频道配置。 */
export async function runSessionSwitchDiagnostics(onProgress: (done: number, total: number) => void) {
	if (running) throw new Error("Session diagnostics are already running");
	running = true;
	const samples: {
		fixture: string;
		round: number;
		sourceBytes: number;
		navigation: number;
		firstPaint: number;
		renderer: Record<string, number>;
		backend: SessionSwitchProbe;
		resources: ReturnType<ReturnType<typeof thumbnailService>["stats"]>;
		afterGC: ReturnType<ReturnType<typeof thumbnailService>["stats"]>;
		fetch: ReturnType<typeof imageReader.stats>;
		fetchMilliseconds: number;
		workerMilliseconds: number;
		resourceReady: number;
		longTasks: number[];
	}[] = [];
	let opened: string | null = null;
	let observer: PerformanceObserver | null = null;
	const longTasks: number[] = [];
	try {
		const fixtures = await getPi().getSessionSwitchFixtures();
		const info = await getPi().getAppInfo();
		// 页面重载后后端可能仍持有上次失败的夹具；先释放，不能把热短路计作GC重开。
		for (const loaded of await getExecutionApi(LOCAL_ENVIRONMENT).getLoadedSessions()) {
			if (!fixtures.some((fixture) => loaded.meta.sessionId === `switch-diagnostic-${fixture.name}`)) {
				throw new Error("Diagnostic instance contains a non-fixture session");
			}
			const closed = await useSessionsStore.getState().closeSession(loaded.meta.sessionId);
			if (!closed.closed) throw new Error("Synthetic session is still running");
		}
		if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
			observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) longTasks.push(entry.duration);
			});
			observer.observe({ entryTypes: ["longtask"] });
		}
		for (const fixture of fixtures) {
			for (let round = 0; round < 30; round++) {
				await getPi().beginSessionSwitchProbe();
				beginRendererSwitchProbe();
				const readBefore = imageReader.stats();
				const workerBefore = thumbnailService().stats().workerRoundTripMilliseconds;
				const taskStart = longTasks.length;
				const start = performance.now();
				const result = await useSessionsStore.getState().openFromHistory(fixture.file);
				if (!result.ok) throw new Error("Synthetic session failed to open");
				opened = result.meta.sessionId;
				const navigation = performance.now() - start;
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const firstPaint = performance.now() - start;
				if (
					!isHistoryReady(opened) ||
					document.querySelector("[data-session-page]")?.getAttribute("data-session-id") !== opened
				) {
					throw new Error("Synthetic history was not installed and painted");
				}
				if (
					useLocalSettingsStore.getState().open ||
					!document.querySelector('[data-session-page] [contenteditable="true"]')
				)
					throw new Error("Synthetic page is covered or not interactive");
				const renderer = finishRendererSwitchProbe();
				const deadline = performance.now() + 5000;
				while (true) {
					const resource = thumbnailService().stats(),
						fetch = imageReader.stats();
					const drawn =
						fixture.name !== "screenshots" ||
						document.querySelector('[data-session-page] [data-history-image="ready"]');
					if (
						!resource.inFlight &&
						resource.waiting === 0 &&
						fetch.active === 0 &&
						fetch.queued === 0 &&
						drawn
					)
						break;
					if (performance.now() > deadline) throw new Error("Synthetic image resources did not settle");
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				}
				const resourceReady = performance.now() - start;
				const resources = thumbnailService().stats(),
					fetch = imageReader.stats();
				assertSwitchResourceBudget(resources, fetch.active);
				useSessionsStore.getState().activateNewSessionDraft();
				const closed = await useSessionsStore.getState().closeSession(opened, "gc");
				if (!closed.closed) throw new Error("Synthetic session refused isolated GC");
				opened = null;
				// 等待实际视图卸载，不能把React尚未提交的旧图片计作GC后状态。
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const backend = await getPi().finishSessionSwitchProbe();
				const afterGC = thumbnailService().stats();
				assertSwitchResourcesReleased(afterGC, backend.source);
				for (const entry of observer?.takeRecords() ?? []) longTasks.push(entry.duration);
				samples.push({
					fixture: fixture.name,
					round,
					sourceBytes: fixture.bytes,
					navigation,
					firstPaint,
					renderer,
					backend,
					resources,
					afterGC,
					fetch,
					fetchMilliseconds: fetch.milliseconds - readBefore.milliseconds,
					workerMilliseconds: resources.workerRoundTripMilliseconds - workerBefore,
					resourceReady,
					longTasks: longTasks.slice(taskStart),
				});
				onProgress(samples.length, fixtures.length * 30);
			}
		}
		return {
			version: 2,
			appVersion: info.version,
			platform: info.platform,
			arch: info.arch,
			electron: info.electron,
			node: info.node,
			build: import.meta.env.DEV ? "dev" : "built-renderer",
			paintDefinition:
				"authoritative history ready + matching mounted session + editable composer + no Settings overlay + two animation frames; resourceReady separately waits for real image drawing/settlement",
			stageDefinition:
				"createSession includes resourceLoad; historyRoundTrip is the real atomic-baseline IPC round trip including source projection/payload accounting; fetch and worker round trips are separately measured and stages are not additive",
			cache: "GC reopen; filesystem cache uncontrolled (not physical cold disk)",
			summary: fixtures.map(({ name }) => {
				const group = samples.filter((sample) => sample.fixture === name);
				return {
					fixture: name,
					count: group.length,
					stages: SESSION_SWITCH_STAGES.map((stage) => {
						const values = group.map((s) =>
							s.backend.stages
								.filter((measurement) => measurement.stage === stage)
								.reduce((sum, measurement) => sum + measurement.milliseconds, 0),
						);
						return { stage, p50: switchPercentile(values, 0.5), p95: switchPercentile(values, 0.95) };
					}),
					payloadBytes: {
						p50: switchPercentile(
							group.map((s) => s.backend.payloadBytes),
							0.5,
						),
						p95: switchPercentile(
							group.map((s) => s.backend.payloadBytes),
							0.95,
						),
					},
					firstPaint: {
						p50: switchPercentile(
							group.map((s) => s.firstPaint),
							0.5,
						),
						p95: switchPercentile(
							group.map((s) => s.firstPaint),
							0.95,
						),
					},
				};
			}),
			samples,
			longTasks,
		};
	} finally {
		observer?.disconnect();
		finishRendererSwitchProbe();
		await getPi()
			.finishSessionSwitchProbe()
			.catch(() => {});
		if (opened) await useSessionsStore.getState().closeSession(opened);
		running = false;
	}
}
