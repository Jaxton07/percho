import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionFileOperations } from "../src/session/file-operations";
import {
	type MediaTransaction,
	type MediaTransactionPhase,
	SessionMediaTransactions,
} from "../src/session/media-maintenance-transactions";
import { SessionMediaStore } from "../src/session/media-store";

const parent = fileURLToPath(
	new URL("../../../.local/tmp/session-media-transaction-tests/", import.meta.url),
);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let root: string,
	file: string,
	original: string,
	loaded: boolean,
	media: SessionMediaStore,
	gate: SessionFileOperations;
beforeEach(async () => {
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(join(parent, "transaction-"));
	await mkdir(join(root, "agent"), { mode: 0o700 });
	await mkdir(join(root, "sessions"), { mode: 0o700 });
	file = join(root, "sessions/source.jsonl");
	loaded = false;
	media = new SessionMediaStore(join(root, "agent/media"));
	gate = new SessionFileOperations();
	const image = {
		data: Buffer.alloc(8192, 31).toString("base64"),
		mimeType: "image/png",
		extra: { retained: true },
	};
	const rows = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source",
			cwd: root,
			timestamp: "2026-01-01T00:00:00Z",
			unknown: 1,
		},
		{
			type: "message",
			id: "user",
			parentId: null,
			message: { role: "user", content: [{ type: "image", ...image }] },
		},
		{
			type: "message",
			id: "a",
			parentId: "user",
			message: {
				role: "toolResult",
				toolName: "show_image",
				content: [{ type: "text", text: "display only" }],
				details: { images: [image, image], unknown: { keep: 1 } },
			},
			unknown: 2,
		},
		{
			type: "message",
			id: "b",
			parentId: "user",
			message: {
				role: "toolResult",
				toolName: "show_image",
				content: [{ type: "text", text: "other branch" }],
				details: { image },
			},
		},
		{
			type: "message",
			id: "read",
			parentId: "a",
			message: { role: "toolResult", toolName: "read", content: [{ type: "image", ...image }] },
		},
	];
	original = rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n\nnot json\r\n";
	await writeFile(file, original, { mode: 0o600 });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
function controller(
	options: {
		fail?: MediaTransactionPhase;
		mutate?: (phase: MediaTransactionPhase, record: MediaTransaction) => Promise<void>;
		space?: bigint;
	} = {},
) {
	return new SessionMediaTransactions({
		root: join(root, "agent/maintenance"),
		media,
		resolveFile: (value) => {
			const path = resolve(value);
			if (!path.startsWith(root + sep)) throw new Error("Outside fixture");
			return path;
		},
		exclusive: (path, operation) => gate.run([path], "maintenance", operation),
		assertIdle: () => {
			if (loaded) throw new Error("Session still loaded or resident");
		},
		checkpoint: async (phase, record) => {
			await options.mutate?.(phase, record);
			if (options.fail === phase) throw new Error(`crash:${phase}`);
		},
		...(options.space === undefined ? {} : { availableBytes: async () => options.space ?? 0n }),
	});
}
const input = () => ({
	sessionFile: file,
	requestId: "request-one",
	expectedHash: hash(original),
	confirmed: true,
});
const parse = (text: string) =>
	text.split(/\r?\n/).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});

describe("单文件持久整理事务", () => {
	it("独立备份/原字节asset/所有分支，逐字节保留非目标行；幂等并可安全恢复", async () => {
		const service = controller(),
			[accepted, duplicate] = await Promise.all([service.create(input()), service.create(input())]);
		expect(duplicate.operationId).toBe(accepted.operationId);
		await expect(service.assertOpenAllowed(file)).rejects.toThrow("unfinished");
		const done = await service.execute(accepted.requestId);
		expect(done.phase).toBe("complete");
		expect(await readFile(done.backup, "utf8")).toBe(original);
		await service.assertOpenAllowed(file);
		const compacted = await readFile(file, "utf8");
		expect(compacted.length).toBeLessThan(original.length);
		expect(compacted).toContain("\r\n\nnot json\r\n");
		const before = parse(original),
			after = parse(compacted);
		expect(after.map((row) => [row.id, row.parentId, row.unknown])).toEqual(
			before.map((row) => [row.id, row.parentId, row.unknown]),
		);
		expect(after.filter((row) => row.message?.role === "user" || row.message?.toolName === "read")).toEqual(
			before.filter((row) => row.message?.role === "user" || row.message?.toolName === "read"),
		);
		for (const row of after.filter((row) => row.message?.toolName === "show_image")) {
			expect(row.message.content).toEqual(before.find((old) => old.id === row.id).message.content);
			const images = row.message.details.images ?? [row.message.details.image];
			for (const image of images) {
				expect(image).toMatchObject({
					kind: "reference",
					ownerSessionId: "source",
					extra: { retained: true },
				});
				expect((await media.read("source", image.id, image.revision)).data).toBe(
					Buffer.alloc(8192, 31).toString("base64"),
				);
			}
		}
		expect(await service.create(input())).toEqual(done);
		expect(await service.execute(done.requestId)).toEqual(done);
		const reopened = controller();
		const restore = await reopened.create({
			...input(),
			requestId: "restore-one",
			expectedHash: hash(compacted),
			restoreFrom: done.requestId,
		});
		expect((await reopened.execute(restore.requestId)).phase).toBe("complete");
		expect(await readFile(file, "utf8")).toBe(original);
		expect(await readFile(done.backup, "utf8")).toBe(original);
	});
	it.each(["queued", "backed-up", "prepared", "publishing", "published"] as const)(
		"%s之后中断，重建控制器能恢复且不覆盖备份",
		async (phase) => {
			const interrupted = controller({ fail: phase });
			if (phase === "queued") await expect(interrupted.create(input())).rejects.toThrow("crash");
			else {
				await interrupted.create(input());
				await expect(interrupted.execute(input().requestId)).rejects.toThrow("crash");
			}
			const fresh = controller(),
				pending = await fresh.get(input().requestId);
			expect(pending?.phase).toBe(phase);
			await expect(fresh.assertOpenAllowed(file)).rejects.toThrow("unfinished");
			expect((await fresh.execute(input().requestId)).phase).toBe("complete");
			const done = await fresh.get(input().requestId);
			if (!done) throw new Error("Missing record");
			expect(await readFile(done.backup, "utf8")).toBe(original);
			await fresh.assertOpenAllowed(file);
		},
	);
	it("中断发布后新requestId不能越过恢复门；原事务恢复并还原后才能开始新请求", async () => {
		const interrupted = controller({ fail: "publishing" });
		await interrupted.create(input());
		await expect(interrupted.execute(input().requestId)).rejects.toThrow("crash:publishing");
		expect(await readFile(file, "utf8")).toBe(original);
		const service = controller();
		await expect(service.create({ ...input(), requestId: "next-request" })).rejects.toThrow("unfinished");
		const resumed = await service.execute(input().requestId);
		expect(resumed.phase).toBe("complete");
		expect(await readFile(resumed.backup, "utf8")).toBe(original);
		const restore = await service.create({
			...input(),
			requestId: "restore-resumed",
			expectedHash: hash(await readFile(file)),
			restoreFrom: resumed.requestId,
		});
		expect((await service.execute(restore.requestId)).phase).toBe("complete");
		expect(await readFile(file, "utf8")).toBe(original);
		await expect(service.create({ ...input(), requestId: "next-request" })).resolves.toMatchObject({
			phase: "queued",
		});
	});
	it("驻留/未确认/不足空间不发布；requestId不能绑定不同输入", async () => {
		const service = controller();
		loaded = true;
		await expect(service.create(input())).rejects.toThrow("resident");
		loaded = false;
		await expect(service.create({ ...input(), confirmed: false })).rejects.toThrow("confirmation");
		await service.create(input());
		await expect(service.create({ ...input(), expectedHash: "0".repeat(64) })).rejects.toThrow("different");
		await expect(controller({ space: 0n }).execute(input().requestId)).rejects.toThrow("Insufficient");
		expect(await readFile(file, "utf8")).toBe(original);
		await service.abandon(input().requestId);
		await service.assertOpenAllowed(file);
	});
	it.each(["ENOSPC", "EACCES"])("原图发布%s不触动来源且独立备份可用", async (code) => {
		media = new SessionMediaStore(join(root, "agent/media"), {
			beforePublish: async () => {
				throw Object.assign(new Error(code), { code });
			},
		});
		const service = controller();
		await service.create(input());
		await expect(service.execute(input().requestId)).rejects.toThrow(code);
		expect(await readFile(file, "utf8")).toBe(original);
		const record = await service.get(input().requestId);
		if (!record) throw new Error("Missing transaction");
		expect(await readFile(record.backup, "utf8")).toBe(original);
		await controller().abandon(record.requestId);
		await controller().assertOpenAllowed(file);
	});
	it("发布前来源追加或候选损坏都拒绝覆盖；备份和原数据保留", async () => {
		const service = controller({
			mutate: async (phase) => {
				if (phase === "publishing") await appendFile(file, "new-user-data\n");
			},
		});
		await service.create(input());
		await expect(service.execute(input().requestId)).rejects.toThrow("Source changed");
		expect(await readFile(file, "utf8")).toBe(original + "new-user-data\n");
		const record = await service.get(input().requestId);
		if (!record) throw new Error("Missing record");
		expect(await readFile(record.backup, "utf8")).toBe(original);
	});
	it("发布意图后损坏候选仍不能发布，原件/备份保持且可安全放弃", async () => {
		const service = controller({
			mutate: async (phase, record) => {
				if (phase === "publishing") await appendFile(record.candidate, "corrupt\n");
			},
		});
		await service.create(input());
		await expect(service.execute(input().requestId)).rejects.toThrow("Candidate changed");
		expect(await readFile(file, "utf8")).toBe(original);
		await controller().abandon(input().requestId);
		await controller().assertOpenAllowed(file);
	});
	it("整理后追加不得简单恢复；完成记录不hash或阻挡正常追加打开", async () => {
		const service = controller();
		await service.create(input());
		const done = await service.execute(input().requestId),
			compacted = await readFile(file, "utf8");
		await appendFile(file, "new-user-data\n");
		await service.assertOpenAllowed(file);
		await service.create({
			...input(),
			requestId: "restore-appended",
			expectedHash: hash(compacted),
			restoreFrom: done.requestId,
		});
		await expect(service.execute("restore-appended")).rejects.toThrow(/changed|appended/);
		await service.assertOpenAllowed(file);
		expect(await readFile(file, "utf8")).toBe(compacted + "new-user-data\n");
		expect(await readFile(done.backup, "utf8")).toBe(original);
	});
	it("中断发布后来源不符持久记录conflict，重建后仍不覆盖新增数据", async () => {
		const interrupted = controller({ fail: "published" });
		await interrupted.create(input());
		await expect(interrupted.execute(input().requestId)).rejects.toThrow("crash");
		await appendFile(file, "new-data-after-publication\n");
		const changed = await readFile(file, "utf8");
		await expect(controller().execute(input().requestId)).rejects.toThrow("refusing recovery");
		expect((await controller().get(input().requestId))?.phase).toBe("conflict");
		await expect(controller().assertOpenAllowed(file)).rejects.toThrow("unfinished");
		expect(await readFile(file, "utf8")).toBe(changed);
	});
	it("备份损坏与元数据损坏不当作无事务，也不覆盖独立备份", async () => {
		const service = controller({ fail: "backed-up" });
		await service.create(input());
		await expect(service.execute(input().requestId)).rejects.toThrow("crash");
		const record = await service.get(input().requestId);
		if (!record) throw new Error("Missing record");
		await writeFile(record.backup, "damaged");
		await expect(controller().execute(record.requestId)).rejects.toThrow("backup integrity");
		expect(await readFile(file, "utf8")).toBe(original);
		expect(await readFile(record.backup, "utf8")).toBe("damaged");
		const journal = join(root, "agent/maintenance/records", `${hash(record.requestId)}.json`);
		await writeFile(journal, "broken");
		await expect(controller().assertOpenAllowed(file)).rejects.toThrow();
	});
});
