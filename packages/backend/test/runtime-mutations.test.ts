import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MutationBook, MutationProtocolError } from "../src/runtime/mutations";

describe("instance mutation admission", () => {
	it("does not repeat a file effect when acknowledgement is lost, including after a new attachment", async () => {
		const dir = resolve("../../.local/tmp/ssh-remote-runtime/mutation-test");
		await mkdir(dir, { recursive: true });
		const file = resolve(dir, "effects.json");
		await writeFile(file, "0");
		const book = new MutationBook();
		book.beginEpoch(1);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const effect = async () => {
			await writeFile(file, String(Number(await readFile(file, "utf8")) + 1));
			await gate;
			return { written: true };
		};
		try {
			const first = book.submit(1, 1, "write", { path: "same" }, () => {}, effect);
			const duplicate = book.submit(1, 1, "write", { path: "same" }, () => {}, effect);
			expect(duplicate).toBe(first);
			expect(book.query(1, 1)).toEqual({ state: "pending" });
			expect(() => book.submit(1, 1, "write", { path: "other" }, () => {}, effect)).toThrow(
				"different payload",
			);
			release();
			await first; // Simulate a completed effect whose ACK was discarded.
			expect(await book.submit(1, 1, "write", { path: "same" }, () => {}, effect)).toEqual({ written: true });
			book.beginEpoch(2);
			expect(book.query(1, 1)).toEqual({ state: "succeeded", result: { written: true } });
			expect(() => book.submit(1, 1, "write", {}, () => {}, effect)).toThrow("Invalid mutation identity");
			expect(await readFile(file, "utf8")).toBe("1");
		} finally {
			release();
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("never reexecutes evicted identities or a capacity refusal, and consumes invalid arguments", async () => {
		const book = new MutationBook({ entries: 1, bytes: 512 });
		book.beginEpoch(1);
		let effects = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = book.submit(
			1,
			1,
			"run",
			{},
			() => {},
			async () => {
				effects++;
				await gate;
			},
		);
		expect(() =>
			book.submit(
				1,
				2,
				"run",
				{},
				() => {},
				() => effects++,
			),
		).toThrow("No receipt capacity");
		release();
		await pending;
		expect(() =>
			book.submit(
				1,
				2,
				"run",
				{},
				() => {},
				() => effects++,
			),
		).toThrow("receipt expired");
		await expect(
			book.submit(
				1,
				3,
				"run",
				{},
				() => {
					throw new Error("bad args");
				},
				() => effects++,
			),
		).rejects.toThrow("bad args");
		expect(book.query(1, 3)).toEqual({ state: "rejected", error: "bad args" });
		expect(() =>
			book.submit(
				1,
				1,
				"run",
				{},
				() => {},
				() => effects++,
			),
		).toThrow("receipt expired");
		expect(() =>
			book.submit(
				1,
				5,
				"run",
				{},
				() => {},
				() => effects++,
			),
		).toThrow("not contiguous");
		expect(effects).toBe(1);
	});
	it("bounds error/result memory and distinguishes rejection before execution from partial failures", async () => {
		const book = new MutationBook({ entries: 2, bytes: 520 });
		book.beginEpoch(1);
		await expect(
			book.submit(
				1,
				1,
				"run",
				{},
				() => {},
				() => {
					throw new MutationProtocolError("NOT_EXECUTED", "offline");
				},
			),
		).rejects.toThrow("offline");
		expect(book.query(1, 1).state).toBe("rejected");
		await expect(
			book.submit(
				1,
				2,
				"run",
				{},
				() => {},
				() => {
					throw new Error("x".repeat(10000));
				},
			),
		).rejects.toThrow();
		expect(book.query(1, 2).state).toBe("failed");
		await book.submit(
			1,
			3,
			"run",
			{},
			() => {},
			() => "x".repeat(10000),
		);
		expect(book.query(1, 3)).toEqual({ state: "succeeded", resultOmitted: true });
		expect(() =>
			book.submit(
				1,
				3,
				"run",
				{},
				() => {},
				() => {},
			),
		).toThrow("completed");
		const restarted = new MutationBook();
		restarted.beginEpoch(1);
		expect(restarted.query(1, 3).state).toBe("expired");
	});
});
