import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { expectNativeExit } from "./native-exit.mjs";

function childFixture() {
	return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
}

test("native exit succeeds even when quitting destroys the CDP reply", { timeout: 5000 }, async () => {
	const child = spawn(process.execPath, ["-e", "process.stdin.once('data',()=>process.exit(0))"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	try {
		await expectNativeExit(child, () => {
			child.stdin.end("quit");
			return new Promise(() => {});
		});
		assert.equal(child.exitCode, 0);
	} finally {
		if (child.exitCode === null) child.kill();
	}
});

test("closed CDP cannot mask a nonzero native exit", { timeout: 5000 }, async () => {
	const child = spawn(process.execPath, ["-e", "process.stdin.once('data',()=>process.exit(7))"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	try {
		await assert.rejects(
			expectNativeExit(child, () => {
				child.stdin.end("quit");
				return Promise.reject(new Error("CDP closed"));
			}),
			/exited with 7/,
		);
	} finally {
		if (child.exitCode === null) child.kill();
	}
});

test("acknowledged quit without native exit still times out", async () => {
	const child = childFixture();
	await assert.rejects(
		expectNativeExit(child, async () => true, { timeoutMs: 10 }),
		/native process exit/,
	);
	assert.equal(child.listenerCount("exit"), 0);
	assert.equal(child.listenerCount("error"), 0);
});

test("an exit before the CDP rejection succeeds and the late rejection is handled", async () => {
	const child = childFixture();
	let rejectReply;
	await expectNativeExit(child, () => {
		const reply = new Promise((_resolve, reject) => {
			rejectReply = reject;
		});
		child.emit("exit", 0, null);
		return reply;
	});
	rejectReply(new Error("CDP closed"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(child.listenerCount("exit"), 0);
	assert.equal(child.listenerCount("error"), 0);
});

test("signal termination fails even if the quit request was acknowledged", async () => {
	const child = childFixture();
	await assert.rejects(
		expectNativeExit(child, () => child.emit("exit", null, "SIGTERM")),
		/exited with SIGTERM/,
	);
});

test("native process errors fail and release listeners", async () => {
	const child = childFixture();
	await assert.rejects(
		expectNativeExit(child, () => child.emit("error", new Error("fixture native error"))),
		/fixture native error/,
	);
	assert.equal(child.listenerCount("exit"), 0);
	assert.equal(child.listenerCount("error"), 0);
});

test("a process that already exited cannot satisfy a new quit request", async () => {
	const child = Object.assign(childFixture(), { exitCode: 0 });
	let requested = false;
	await assert.rejects(
		expectNativeExit(child, () => {
			requested = true;
		}),
		/exited before quit/,
	);
	assert.equal(requested, false);
});
