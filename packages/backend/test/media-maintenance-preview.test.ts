import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { SessionMediaJob } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFileOperations } from "../src/session/file-operations";
import { SessionMediaMaintenanceJobs } from "../src/session/media-maintenance-jobs";

const parent = fileURLToPath(new URL("../../../.local/tmp/session-media-preview-tests/", import.meta.url));
let root: string;
const services: SessionMediaMaintenanceJobs[] = [];
beforeEach(async () => {
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(join(parent, "preview-"));
});
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose()));
	await rm(root, { recursive: true, force: true });
});
function service(workerPath?: string) {
	const gate = new SessionFileOperations();
	const jobs = new SessionMediaMaintenanceJobs({
		workerPath,
		resolveFile: (file) => {
			const path = resolve(file);
			if (!path.startsWith(root + sep)) throw new Error("Outside test root");
			return path;
		},
		read: (file, operation) => gate.run([file], "preview", operation),
	});
	services.push(jobs);
	return { jobs, gate };
}
async function finished(jobs: SessionMediaMaintenanceJobs, job: SessionMediaJob) {
	await vi.waitFor(() => expect(["completed", "cancelled", "failed"]).toContain(jobs.get(job.jobId).status), {
		timeout: 10_000,
		interval: 10,
	});
	return jobs.get(job.jobId);
}
const header = (version = CURRENT_SESSION_VERSION) => ({
	type: "session",
	version,
	id: "source",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/synthetic",
});

describe("后台单文件只读整理预览", () => {
	it("真实worker扫描所有分支，去重空间但逐处计替换，保留坏行/未知字段/user和read图", async () => {
		const file = join(root, "source.jsonl"),
			image = {
				data: Buffer.alloc(2048, 23).toString("base64"),
				mimeType: "image/png",
				unknown: { keep: true },
			};
		const rows = [
			header(),
			{
				type: "message",
				id: "branch-a",
				parentId: null,
				message: {
					role: "toolResult",
					toolName: "show_image",
					details: { images: [image, image], unknown: 9 },
				},
			},
			{
				type: "message",
				id: "branch-b",
				parentId: null,
				message: { role: "toolResult", toolName: "show_image", details: { image } },
			},
			{ type: "message", id: "user", message: { role: "user", content: [{ type: "image", ...image }] } },
			{
				type: "message",
				id: "read",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "image", ...image }],
					details: { images: [image] },
				},
			},
		];
		const original = `${rows.map((row) => JSON.stringify(row)).join("\r\n")}\r\nnot json\n\n`;
		await writeFile(file, original);
		const before = await readdir(root);
		const { jobs } = service(),
			started = jobs.startPreview(file);
		expect(["queued", "running"]).toContain(started.status);
		expect(jobs.startPreview(file).jobId).toBe(started.jobId);
		const done = await finished(jobs, started);
		expect(done.status).toBe("completed");
		expect(done.result).toMatchObject({
			supported: true,
			imageCount: 3,
			uniqueImages: 1,
			originalImageBytes: 2048,
			invalidLines: 1,
			skippedImages: 0,
			fileBytes: Buffer.byteLength(original),
			sourceHash: createHash("sha256").update(original).digest("hex"),
		});
		const result = done.result;
		if (!result) throw new Error("Missing preview result");
		expect(result.projectedFileBytes).toBeLessThan(result.fileBytes);
		expect(result.additionalPeakBytes).toBe(result.backupBytes + result.projectedFileBytes + 2048);
		expect(await readFile(file, "utf8")).toBe(original);
		expect(await readdir(root)).toEqual(before);
	});
	it.each([CURRENT_SESSION_VERSION - 1, CURRENT_SESSION_VERSION + 1])(
		"版本%s明确不支持，不调用SDK迁移原文件",
		async (version) => {
			const file = join(root, "version.jsonl"),
				original = `${JSON.stringify(header(version))}\n`;
			await writeFile(file, original);
			const { jobs } = service(),
				done = await finished(jobs, jobs.startPreview(file));
			expect(done.result).toMatchObject({
				supported: false,
				reason: "unsupported-version",
				sourceVersion: version,
			});
			expect(await readFile(file, "utf8")).toBe(original);
		},
	);
	it("无收益、损坏header与读取失败分开反馈，链接不跟随", async () => {
		const { jobs } = service(),
			good = join(root, "empty.jsonl"),
			bad = join(root, "bad.jsonl");
		await writeFile(good, JSON.stringify(header()));
		await writeFile(bad, "broken\n");
		expect((await finished(jobs, jobs.startPreview(good))).result).toMatchObject({
			supported: true,
			reason: "no-benefit",
		});
		expect((await finished(jobs, jobs.startPreview(bad))).result).toMatchObject({
			supported: false,
			reason: "invalid-header",
		});
		expect((await finished(jobs, jobs.startPreview(join(root, "missing.jsonl")))).status).toBe("failed");
		if (process.platform !== "win32") {
			const link = join(root, "link.jsonl");
			await symlink(good, link);
			expect((await finished(jobs, jobs.startPreview(link))).status).toBe("failed");
		}
	});
	it("短启动、单worker/四个总任务；取消等待真实退出，释放互斥而不写源", async () => {
		const worker = join(root, "wait.mjs");
		await writeFile(
			worker,
			"import {parentPort} from 'node:worker_threads'; setInterval(()=>parentPort.postMessage({type:'progress',processedBytes:1,totalBytes:9}),10);",
		);
		const { jobs, gate } = service(worker),
			paths = Array.from({ length: 6 }, (_, i) => join(root, `${i}.jsonl`));
		for (const file of paths) await writeFile(file, JSON.stringify(header()));
		const first = paths[0],
			fifth = paths[4];
		if (!first || !fifth) throw new Error("Missing fixture path");
		const initial = jobs.startPreview(first);
		for (const file of paths.slice(1, 4)) jobs.startPreview(file);
		expect(() => jobs.startPreview(fifth)).toThrow("queue is full");
		await vi.waitFor(() => expect(jobs.stats().workers).toBe(1));
		expect(gate.has(first)).toBe(true);
		expect(() => gate.acquire([first], "delete")).toThrow("busy");
		jobs.cancel(initial.jobId);
		await finished(jobs, initial);
		await vi.waitFor(() => expect(gate.has(first)).toBe(false));
		expect(await readFile(first, "utf8")).toBe(JSON.stringify(header()));
		await jobs.dispose();
		expect(jobs.stats()).toMatchObject({ workers: 0, queued: 0 });
	});
});
