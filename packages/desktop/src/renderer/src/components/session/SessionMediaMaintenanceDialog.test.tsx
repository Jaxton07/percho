// @vitest-environment happy-dom
import type { SessionMediaJob, SessionMeta } from "@percho/shared";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionMediaMaintenanceStore } from "../../stores/session-media-maintenance";
import { SessionMediaMaintenanceDialog } from "./SessionMediaMaintenanceDialog";

const fake = vi.hoisted(() => ({
	startSessionMediaPreview: vi.fn(),
	getSessionMediaJob: vi.fn(),
	cancelSessionMediaJob: vi.fn(),
	getSessionMediaMaintenance: vi.fn(),
	getSessionMediaTransaction: vi.fn(),
	startSessionMediaCompaction: vi.fn(),
	startSessionMediaRestore: vi.fn(),
	resumeSessionMediaJob: vi.fn(),
	abandonSessionMediaJob: vi.fn(),
}));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => fake }));
vi.mock("../../i18n", () => ({
	useT: () => (key: string, values?: Record<string, unknown>) =>
		`${key} ${Object.values(values ?? {}).join(" ")}`,
}));
const session = { sessionId: "private-session", sessionFile: "/synthetic/source.jsonl" } as SessionMeta;
const running: SessionMediaJob = {
	kind: "preview",
	jobId: "job",
	sessionFile: "/synthetic/source.jsonl",
	status: "running",
	createdAt: 1,
	updatedAt: 1,
	processedBytes: 2,
	totalBytes: 3,
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	fake.cancelSessionMediaJob.mockResolvedValue({ ...running, status: "cancelled" });
	fake.getSessionMediaMaintenance.mockResolvedValue(null);
	fake.getSessionMediaTransaction.mockResolvedValue(null);
	useSessionMediaMaintenanceStore.setState({ session: null });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	useSessionMediaMaintenanceStore.setState({ session: null });
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
const render = async () => {
	useSessionMediaMaintenanceStore.getState().open(session);
	await act(async () => root.render(<SessionMediaMaintenanceDialog />));
};

describe("单文件整理收益对话框", () => {
	it("只调用预览，展示备份和保守峰值，不把备份当作节省", async () => {
		fake.startSessionMediaPreview.mockResolvedValue({
			...running,
			status: "completed",
			result: {
				supported: true,
				sourceHash: "hash",
				sourceFingerprint: "version",
				fileBytes: 36 * 1024 * 1024,
				projectedFileBytes: 1024,
				imageCount: 63,
				uniqueImages: 20,
				originalImageBytes: 10,
				backupBytes: 36 * 1024 * 1024,
				additionalPeakBytes: 72 * 1024 * 1024,
				invalidLines: 1,
				skippedImages: 2,
			},
		});
		await render();
		expect(fake.startSessionMediaPreview).toHaveBeenCalledWith({ sessionFile: session.sessionFile });
		const text = document.querySelector('[role="dialog"]')?.textContent;
		expect(text).toContain("63");
		expect(text).toContain("72.00 MiB");
		expect(text).toContain("36.00 MiB");
		expect(fake.getSessionMediaJob).not.toHaveBeenCalled();
	});
	it("关闭取消已知任务并停止轮询，迟到结果不重新显示", async () => {
		vi.useFakeTimers();
		let finish!: (job: SessionMediaJob) => void;
		fake.startSessionMediaPreview.mockResolvedValue(running);
		fake.getSessionMediaJob.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await act(async () => {
			vi.advanceTimersByTime(250);
		});
		expect(fake.getSessionMediaJob).toHaveBeenCalledWith({ jobId: "job" });
		const button = document.querySelector<HTMLButtonElement>('[role="dialog"] button');
		if (!button) throw new Error("Missing close button");
		await act(async () => button.click());
		expect(fake.cancelSessionMediaJob).toHaveBeenCalledWith({ jobId: "job" });
		await act(async () => finish({ ...running, status: "completed" }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(useSessionMediaMaintenanceStore.getState().session).toBeNull();
	});
	it("启动回应晚于关闭也会取消真实任务，不重新挂载", async () => {
		let accept!: (job: SessionMediaJob) => void;
		fake.startSessionMediaPreview.mockImplementation(
			() =>
				new Promise((resolve) => {
					accept = resolve;
				}),
		);
		await render();
		const button = document.querySelector<HTMLButtonElement>('[role="dialog"] button');
		if (!button) throw new Error("Missing close button");
		await act(async () => button.click());
		await act(async () => accept(running));
		expect(fake.cancelSessionMediaJob).toHaveBeenCalledWith({ jobId: "job" });
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
	it("StrictMode重放effect不会取消新界面合并的后台任务", async () => {
		vi.useFakeTimers();
		fake.startSessionMediaPreview.mockResolvedValue(running);
		fake.getSessionMediaJob.mockResolvedValue({
			...running,
			status: "completed",
			result: { supported: true, reason: "no-benefit" },
		});
		useSessionMediaMaintenanceStore.getState().open(session);
		await act(async () =>
			root.render(
				<StrictMode>
					<SessionMediaMaintenanceDialog />
				</StrictMode>,
			),
		);
		expect(fake.cancelSessionMediaJob).not.toHaveBeenCalled();
		await act(async () => {
			vi.advanceTimersByTime(250);
		});
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("mediaPreview.noBenefit");
	});
	it("执行必须二次确认，携带预览摘要和稳定requestId；关闭不取消持久整理", async () => {
		fake.startSessionMediaPreview.mockResolvedValue({
			...running,
			status: "completed",
			result: {
				supported: true,
				sourceHash: "verified-hash",
				fileBytes: 10000,
				projectedFileBytes: 1000,
				imageCount: 1,
				uniqueImages: 1,
				backupBytes: 10000,
				additionalPeakBytes: 21000,
			},
		});
		fake.startSessionMediaCompaction.mockResolvedValue({
			...running,
			kind: "compact",
			jobId: "durable",
			status: "running",
		});
		await render();
		const find = (text: string) =>
			Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
				button.textContent?.includes(text),
			);
		let button = find("mediaMaintenance.action.compact");
		if (!button) throw new Error("No compact button");
		await act(async () => button?.click());
		expect(fake.startSessionMediaCompaction).not.toHaveBeenCalled();
		button = find("mediaMaintenance.action.compact");
		if (!button) throw new Error("No confirmation button");
		await act(async () => button?.click());
		expect(fake.startSessionMediaCompaction).toHaveBeenCalledWith({
			sessionFile: session.sessionFile,
			requestId: expect.any(String),
			expectedHash: "verified-hash",
			confirmed: true,
		});
		const close = document.querySelector<HTMLButtonElement>('[role="dialog"] > button');
		if (!close) throw new Error("No close button");
		await act(async () => close.click());
		expect(fake.cancelSessionMediaJob).not.toHaveBeenCalled();
	});
	it("启动结果未知时按同requestId查询，不自动重投新的整理", async () => {
		fake.startSessionMediaPreview.mockResolvedValue({
			...running,
			status: "completed",
			result: {
				supported: true,
				sourceHash: "verified-hash",
				fileBytes: 10000,
				projectedFileBytes: 1000,
				imageCount: 1,
				uniqueImages: 1,
				backupBytes: 10000,
				additionalPeakBytes: 21000,
			},
		});
		fake.startSessionMediaCompaction.mockRejectedValue(new Error("Connection lost"));
		fake.getSessionMediaTransaction.mockResolvedValue({
			requestId: "existing",
			operationId: "durable",
			kind: "compact",
			phase: "publishing",
		});
		fake.getSessionMediaJob.mockResolvedValue({
			...running,
			kind: "compact",
			status: "failed",
			transaction: { requestId: "existing", operationId: "durable", kind: "compact", phase: "publishing" },
		});
		await render();
		const select = () =>
			Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
				button.textContent?.includes("mediaMaintenance.action.compact"),
			);
		await act(async () => select()?.click());
		await act(async () => select()?.click());
		expect(fake.startSessionMediaCompaction).toHaveBeenCalledTimes(1);
		const request = fake.startSessionMediaCompaction.mock.calls[0]?.[0];
		expect(request?.requestId).toBeTruthy();
		expect(fake.getSessionMediaTransaction).toHaveBeenCalledWith({ requestId: request.requestId });
		expect(fake.getSessionMediaJob).toHaveBeenCalledWith({ jobId: "durable" });
	});
	it("重开查询持久未完成状态，提供检查恢复和安全放弃，不重新启动整理", async () => {
		const transaction = {
			requestId: "original-request",
			operationId: "durable",
			kind: "compact",
			phase: "publishing",
			backup: "/private/backup",
		};
		fake.getSessionMediaMaintenance.mockResolvedValue(transaction);
		fake.getSessionMediaJob.mockResolvedValue({
			...running,
			kind: "compact",
			status: "failed",
			transaction,
			error: "Interrupted",
		});
		await render();
		expect(document.body.textContent).toContain("mediaMaintenance.action.resume");
		expect(document.body.textContent).toContain("mediaMaintenance.action.abandon");
		expect(document.body.textContent).toContain("/private/backup");
		expect(fake.startSessionMediaPreview).not.toHaveBeenCalled();
		expect(fake.startSessionMediaCompaction).not.toHaveBeenCalled();
	});
	it("读取错误明确反馈且没有执行整理入口", async () => {
		fake.startSessionMediaPreview.mockRejectedValue(new Error("Source changed"));
		await render();
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Source changed");
		expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("mediaPreview.execute");
	});
});
