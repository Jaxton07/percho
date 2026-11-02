import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionMediaJob } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionHandlers } from "../src/execution-handlers";
import { PiBackend } from "../src/pi-backend";
import { maintenancePaths } from "../src/session/maintenance-paths";
import { SessionMediaStore } from "../src/session/media-store";

const parent = fileURLToPath(new URL("../../../.local/tmp/session-media-api-tests/", import.meta.url));
let root: string, file: string, original: string;
const backends: PiBackend[] = [];
beforeEach(async () => {
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(join(parent, "api-"));
	await mkdir(join(root, "sessions"), { mode: 0o700 });
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.spyOn(ModelRuntime, "create").mockRejectedValue(new Error("No model runtime in maintenance"));
	file = join(root, "sessions/source.jsonl");
	original = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source",
			cwd: root,
			timestamp: "2026-01-01T00:00:00Z",
		},
		{
			type: "message",
			id: "image",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "toolResult",
				toolName: "show_image",
				content: [{ type: "text", text: "Only display" }],
				details: {
					images: [{ data: Buffer.alloc(128 * 1024, 7).toString("base64"), mimeType: "image/png" }],
				},
				isError: false,
			},
		},
	]
		.map((row) => JSON.stringify(row))
		.join("\n");
	await writeFile(file, original);
});
afterEach(() => {
	for (const backend of backends.splice(0)) backend.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	return rm(root, { recursive: true, force: true });
});
function backend() {
	const b = new PiBackend({
		projectTrust: false,
		permissionGates: false,
		maintenanceSessionRoot: root,
		sessionMediaStore: new SessionMediaStore(join(root, "media")),
	});
	backends.push(b);
	return b;
}
async function finished(b: PiBackend, job: SessionMediaJob) {
	let value = job;
	await vi.waitFor(
		async () => {
			value = await b.getSessionMediaJob(job.jobId);
			expect(["completed", "failed", "cancelled"]).toContain(value.status);
		},
		{ timeout: 15_000, interval: 20 },
	);
	return value;
}
const request = () => ({
	requestId: "safe-request",
	sessionFile: file,
	expectedHash: createHash("sha256").update(original).digest("hex"),
	confirmed: true,
});

describe("生产后台维护短接口及持久查询", () => {
	it("真实handler启动/查询/恢复原件；重建backend后jobId/requestId仍能查询，SDK模型上下文零创建", async () => {
		const b = backend(),
			handlers = createExecutionHandlers(b),
			start = performance.now();
		const accepted = await handlers.startSessionMediaCompaction(request());
		expect(["queued", "running"]).toContain(accepted.status);
		expect(performance.now() - start).toBeLessThan(1000);
		// 操作门/持久恢复门应在任何SDK实例创建前拒绝相同来源打开。
		await expect(b.openSession(file)).rejects.toThrow(/busy|unfinished/);
		const done = await finished(b, accepted);
		expect(done.status, done.error).toBe("completed");
		expect(done.transaction?.phase).toBe("complete");
		const fresh = backend(),
			persistent = await fresh.getSessionMediaJob(done.jobId);
		expect(persistent.status).toBe("completed");
		expect(persistent.requestId).toBe(request().requestId);
		expect(await fresh.getSessionMediaTransaction(request().requestId)).toEqual(done.transaction);
		const duplicate = await fresh.startSessionMediaCompaction(request());
		expect(duplicate.jobId).toBe(done.jobId);
		expect(duplicate.status).toBe("completed");
		const restore = await handlers.startSessionMediaRestore({
			requestId: "restore",
			compactionRequestId: request().requestId,
			confirmed: true,
		});
		expect((await finished(b, restore)).status).toBe("completed");
		expect(await readFile(file, "utf8")).toBe(original);
		expect(ModelRuntime.create).not.toHaveBeenCalled();
	});
	it("驻留只读视图及运行源都不能启动整理", async () => {
		const b = backend();
		const internal = b as unknown as {
			registry: { add(entry: unknown): void; delete(id: string): void };
			runningSubagents: Map<string, unknown>;
		};
		internal.registry.add({
			session: { sessionId: "source", sessionFile: file },
			cwd: root,
			readOnly: true,
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
			modeRef: { current: "default" },
		});
		await expect(b.startSessionMediaCompaction(request())).rejects.toThrow(/Close/);
		internal.registry.delete("source");
		internal.runningSubagents.set("source", { getSource: () => ({ sessionFile: file }) });
		await expect(b.startSessionMediaCompaction(request())).rejects.toThrow(/Running/);
		internal.runningSubagents.clear();
		expect(await readFile(file, "utf8")).toBe(original);
	});
	it("正在打开与频道驻留也拒绝，不能只检查renderer的当前页", async () => {
		const b = backend(),
			internal = b as unknown as {
				fileOperations: { acquire(files: string[], kind: string): { release(): void } };
				channelSubs: { report(id: string, topics: ReadonlySet<string>): void };
			};
		const lease = internal.fileOperations.acquire([file], "open");
		try {
			await expect(b.startSessionMediaCompaction(request())).rejects.toThrow("busy");
		} finally {
			lease.release();
		}
		internal.channelSubs.report("source", new Set(["resident-topic"]));
		const started = await b.startSessionMediaCompaction(request()),
			done = await finished(b, started);
		expect(done.status).toBe("failed");
		expect(done.error).toContain("Channel-resident");
		internal.channelSubs.report("source", new Set());
		expect(await readFile(file, "utf8")).toBe(original);
	});
	it("维护根批准不能变成任意文件读取/链接入口", async () => {
		const policy = maintenancePaths(root);
		expect(policy.resolveFile(file)).toBe(file);
		const outside = join(root, "outside.jsonl");
		await writeFile(outside, original);
		expect(() => policy.resolveFile(outside)).toThrow("managed");
		if (process.platform !== "win32") {
			const link = join(root, "sessions/link.jsonl");
			await symlink(file, link);
			expect(() => policy.resolveFile(link)).toThrow("linked");
		}
		expect(() => backend().startSessionMediaPreview(outside)).toThrow();
	});
});
