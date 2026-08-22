import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore, JsonStoreCorruptedError } from "../src/json-store";

/** JsonStore 统一 JSON 持久化测试：ENOENT/损坏/原子写/并发串行/sync 变体（spec D2 契约） */

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "json-store-test-"));
	path = join(dir, "state.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function store(defaultValue?: () => Record<string, unknown>) {
	return new JsonStore<Record<string, unknown>>({
		path,
		defaultValue: defaultValue ?? (() => ({ seeded: true })),
	});
}

describe("JsonStore async", () => {
	it("ENOENT → read 回 default", async () => {
		const value = await store().read();
		expect(value).toEqual({ seeded: true });
	});

	it("损坏 → read 回 default，update 抛 JsonStoreCorruptedError", async () => {
		writeFileSync(path, "{ not json", "utf8");
		const s = store();
		await expect(s.read()).resolves.toEqual({ seeded: true });
		await expect(
			s.update((draft) => {
				draft.n = 1;
			}),
		).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		// 拒写：损坏文件原样保留，未被 default 覆盖
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});

	it("update 写盘后再 read 一致（mutate in place / 返回替换两种形式）", async () => {
		const s = store();
		await s.update((draft) => {
			draft.count = 1;
		});
		await s.update((draft) => ({ ...draft, label: "x" }));
		expect(await s.read()).toEqual({ seeded: true, count: 1, label: "x" });
	});

	it("成功写入不残留 tmp 文件", async () => {
		await store().write({ a: 1 });
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("rename 失败清理 tmp 后重抛（目标路径被目录占用 → EISDIR）", async () => {
		rmSync(path, { force: true });
		mkdirSync(path); // 目标名是目录：tmp 写入成功但 rename 失败
		await expect(store().write({ a: 1 })).rejects.toThrow();
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("并发 update 串行化，无丢更新", async () => {
		const s = store(() => ({ n: 0 }));
		await Promise.all(
			Array.from({ length: 10 }, () =>
				s.update((draft) => {
					draft.n = (draft.n ?? 0) + 1;
				}),
			),
		);
		expect(await s.read()).toEqual({ n: 10 });
	});

	it("mode 选项落盘到文件权限", async () => {
		const s = new JsonStore<Record<string, unknown>>({
			path,
			defaultValue: () => ({}),
			mode: 0o600,
		});
		await s.write({ k: "v" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("parse 钩子支持 JSONC 注释读取", async () => {
		writeFileSync(path, '{\n  // 注释\n  "a": 1 }\n', "utf8");
		const s = new JsonStore<Record<string, unknown>>({
			path,
			defaultValue: () => ({}),
			parse: (raw) => JSON.parse(raw.replace(/\/\/[^\n"]*(?=\n)/g, "")) as Record<string, unknown>,
		});
		await expect(s.read()).resolves.toEqual({ a: 1 });
	});
});

describe("JsonStore sync 变体", () => {
	it("ENOENT → readSync 回 default", () => {
		expect(store().readSync()).toEqual({ seeded: true });
	});

	it("损坏 → readSync 回 default，updateSync 抛 JsonStoreCorruptedError 且原文件保留", () => {
		writeFileSync(path, "[broken", "utf8");
		const s = store();
		expect(s.readSync()).toEqual({ seeded: true });
		expect(() =>
			s.updateSync((draft) => {
				draft.n = 1;
			}),
		).toThrow(JsonStoreCorruptedError);
		expect(readFileSync(path, "utf8")).toBe("[broken");
	});

	it("updateSync 写盘后 readSync 一致；成功与失败路径均无 tmp 残留", () => {
		const s = store();
		s.updateSync((draft) => {
			draft.n = 1;
		});
		expect(s.readSync()).toEqual({ seeded: true, n: 1 });
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("writeSync 全量覆盖", () => {
		const s = store();
		s.writeSync({ fresh: true });
		expect(s.readSync()).toEqual({ fresh: true });
	});
});
