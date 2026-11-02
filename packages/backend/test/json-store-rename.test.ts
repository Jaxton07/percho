import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	rename: vi.fn<typeof import("node:fs/promises").rename>(),
	actualRename: undefined as typeof import("node:fs/promises").rename | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	io.actualRename = original.rename;
	return { ...original, rename: io.rename };
});

import { JsonStore } from "../src/json-store";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const actualRename = io.actualRename;
if (!platform || !actualRename) throw new Error("Missing native test prerequisites");
let root: string;
let path: string;
let store: JsonStore<{ count: number }>;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "json-rename-"));
	path = join(root, "state.json");
	store = new JsonStore({ path, durable: true, defaultValue: () => ({ count: 0 }) });
	store.writeSync({ count: 1 });
	io.rename.mockReset().mockImplementation(actualRename);
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	rmSync(root, { recursive: true, force: true });
});

describe("bounded Windows JSON record rename", () => {
	it.each(["EPERM", "EACCES", "EBUSY"])(
		"retries transient %s without removing the old record",
		async (code) => {
			const error = Object.assign(new Error("fixture sharing violation"), { code });
			io.rename.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
			io.rename.mockImplementation(async (...args) => {
				expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count: 1 });
				await actualRename(...args);
			});
			await store.write({ count: 2 });
			expect(io.rename).toHaveBeenCalledTimes(3);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count: 2 });
			expect(readdirSync(root)).toEqual(["state.json"]);
		},
	);
	it("propagates a persistent lock after five attempts and keeps the original record intact", async () => {
		const error = Object.assign(new Error("fixture persistent lock"), { code: "EPERM" });
		io.rename.mockRejectedValue(error);
		await expect(store.write({ count: 2 })).rejects.toBe(error);
		expect(io.rename).toHaveBeenCalledTimes(5);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count: 1 });
		expect(readdirSync(root)).toEqual(["state.json"]);
	});
	it("does not retry non-sharing errors", async () => {
		const error = Object.assign(new Error("fixture IO failure"), { code: "EIO" });
		io.rename.mockRejectedValue(error);
		await expect(store.write({ count: 2 })).rejects.toBe(error);
		expect(io.rename).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count: 1 });
	});
	it("does not change other platforms' rename failure semantics", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const error = Object.assign(new Error("fixture permission failure"), { code: "EPERM" });
		io.rename.mockRejectedValue(error);
		await expect(store.write({ count: 2 })).rejects.toBe(error);
		expect(io.rename).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count: 1 });
	});
});
