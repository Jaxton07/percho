import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "../src/json-store";

let root: string;
let path: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "json-durable-"));
	path = join(root, "state.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(["async", "sync"] as const)("durable JsonStore (%s)", (method) => {
	it("flushes writable file contents before atomically replacing existing metadata", async () => {
		const store = new JsonStore({ path, durable: true, defaultValue: () => ({ count: 0 }) });
		for (const count of [1, 2]) {
			if (method === "async") await store.write({ count });
			else store.writeSync({ count });
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count });
			expect(readdirSync(root)).toEqual(["state.json"]);
		}
	});
	it("closes and removes the writable temporary file on serialization failure", async () => {
		const store = new JsonStore({ path, durable: true, defaultValue: () => ({ count: 0 }) });
		await store.write({ count: 1 });
		const failing = new JsonStore({
			path,
			durable: true,
			defaultValue: () => ({ count: 0 }),
			stringify: () => {
				throw new Error("fixture serialization failure");
			},
		});
		if (method === "async") await expect(failing.write({ count: 2 })).rejects.toThrow("serialization");
		else expect(() => failing.writeSync({ count: 2 })).toThrow("serialization");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count: 1 });
		expect(readdirSync(root)).toEqual(["state.json"]);
	});
});
