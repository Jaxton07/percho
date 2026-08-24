import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acpStateFile,
	hydrateAcpState,
	loadAcpState,
	resetAcpState,
	saveAcpState,
} from "../src/tools/acp-context/store";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "acp-store-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("acpStateFile", () => {
	it("sessionFile + .acp.json；空值返回 null", () => {
		expect(acpStateFile("/tmp/s/x.jsonl")).toBe("/tmp/s/x.jsonl.acp.json");
		expect(acpStateFile(undefined)).toBeNull();
		expect(acpStateFile(null)).toBeNull();
	});
});

describe("hydrateAcpState", () => {
	it("合法形状补全缺省字段", () => {
		const state = createInitialState();
		state.blocks.push({
			blockId: "b1",
			runId: "r1",
			tier: 1,
			summary: "s".repeat(60),
			directMessageIds: ["a"],
			effectiveMessageIds: ["a"],
			directBlockIds: [],
			compressedTokens: 100,
			createdAt: 1,
			survivedCount: 0,
			generation: "young",
			active: true,
		});
		const persisted = JSON.parse(JSON.stringify({ version: 1, ...state })) as unknown;
		// 删掉可选字段模拟旧版本文件
		(persisted as Record<string, unknown>).tokenSnapshot = undefined;
		const hydrated = hydrateAcpState(persisted);
		expect(hydrated).not.toBeNull();
		expect(hydrated?.blocks).toHaveLength(1);
		expect(hydrated?.tokenSnapshot).toEqual({});
		expect(hydrated?.nudge.lastShownByTier).toEqual({});
	});

	it("非法形状返回 null", () => {
		expect(hydrateAcpState(null)).toBeNull();
		expect(hydrateAcpState("x")).toBeNull();
		expect(hydrateAcpState({ blocks: "no" })).toBeNull();
		expect(hydrateAcpState({ blocks: [], messageRefs: 3 })).toBeNull();
	});
});

describe("save/load round-trip", () => {
	it("原子写 + 读回一致；目录自动创建", async () => {
		const sessionFile = join(dir, "nested", "s.jsonl");
		const state = createInitialState();
		state.stats.tokensCompressed = 4321;
		await saveAcpState(sessionFile, state);
		const raw = JSON.parse(await readFile(`${sessionFile}.acp.json`, "utf8")) as {
			version: number;
			stats: { tokensCompressed: number };
		};
		expect(raw.version).toBe(1);
		expect(raw.stats.tokensCompressed).toBe(4321);
		const loaded = await loadAcpState(sessionFile);
		expect(loaded.stats.tokensCompressed).toBe(4321);
	});

	it("损坏文件回退初始 state（不抛）", async () => {
		const sessionFile = join(dir, "s.jsonl");
		await writeFile(`${sessionFile}.acp.json`, "{not json", "utf8");
		const loaded = await loadAcpState(sessionFile);
		expect(loaded.blocks).toEqual([]);
	});

	it("无 sessionFile 全 no-op", async () => {
		await expect(saveAcpState(undefined, createInitialState())).resolves.toBeUndefined();
		await expect(loadAcpState(undefined)).resolves.toMatchObject({ blocks: [] });
		await expect(resetAcpState(undefined)).resolves.toBeUndefined();
	});
});

describe("fork 父链继承", () => {
	it("本会话无 state 时沿 parentSession 链继承最近非空 state", async () => {
		const parentFile = join(dir, "parent.jsonl");
		const parentHeader = { type: "session", id: "p1", cwd: "/tmp", parentSession: undefined };
		await writeFile(parentFile, `${JSON.stringify(parentHeader)}\n`, "utf8");
		const parentState = createInitialState();
		parentState.stats.compressionCount = 7;
		parentState.blocks.push({
			blockId: "b1",
			runId: "r1",
			tier: 1,
			summary: "s".repeat(60),
			directMessageIds: ["a"],
			effectiveMessageIds: ["a"],
			directBlockIds: [],
			compressedTokens: 100,
			createdAt: 1,
			survivedCount: 0,
			generation: "young",
			active: true,
		});
		await saveAcpState(parentFile, parentState);

		const childFile = join(dir, "child.jsonl");
		await writeFile(
			childFile,
			`${JSON.stringify({ ...parentHeader, id: "c1", parentSession: parentFile })}\n`,
			"utf8",
		);

		const loaded = await loadAcpState(childFile);
		expect(loaded.stats.compressionCount).toBe(7);
	});

	it("本会话显式空 state（曾重置）不继承父链", async () => {
		const parentFile = join(dir, "p2.jsonl");
		await writeFile(parentFile, `${JSON.stringify({ type: "session", id: "p2" })}\n`, "utf8");
		await saveAcpState(parentFile, createInitialState());
		const childFile = join(dir, "c2.jsonl");
		await writeFile(
			childFile,
			`${JSON.stringify({ type: "session", id: "c2", parentSession: parentFile })}\n`,
			"utf8",
		);
		// 子会话自己有 state 文件（块为空）
		await saveAcpState(childFile, createInitialState());
		const loaded = await loadAcpState(childFile);
		expect(loaded.stats.compressionCount).toBe(0);
	});

	it("父链超深（>8）终止回退初始", async () => {
		// 构造 10 层链，只有最底层有 state
		const files: string[] = [];
		for (let i = 0; i < 10; i++) {
			const f = join(dir, `chain${i}.jsonl`);
			await writeFile(
				f,
				`${JSON.stringify({ type: "session", id: `chain${i}`, parentSession: i > 0 ? files[i - 1] : undefined })}\n`,
				"utf8",
			);
			files.push(f);
		}
		await saveAcpState(files[9], {
			...createInitialState(),
			stats: { tokensCompressed: 99, compressionCount: 99 },
		});
		const loaded = await loadAcpState(files[0]);
		expect(loaded.stats.compressionCount).toBe(0); // 链深 8 次内不可达 → 初始 state
	});
});

describe("resetAcpState", () => {
	it("删除 state 文件；ENOENT 静默", async () => {
		const sessionFile = join(dir, "s3.jsonl");
		await saveAcpState(sessionFile, createInitialState());
		await resetAcpState(sessionFile);
		const loaded = await loadAcpState(sessionFile);
		expect(loaded.blocks).toEqual([]);
		await expect(resetAcpState(sessionFile)).resolves.toBeUndefined();
	});
});
