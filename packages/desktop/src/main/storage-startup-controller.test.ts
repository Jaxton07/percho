import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectLocalStorage } from "../../../backend/src/storage/path-policy";
import { privateDirectory } from "../../../backend/src/storage/private-directory";
import { StorageStartupController } from "./storage-startup-controller";

vi.mock("node:fs/promises", { spy: true });

let root: string;
const previous = process.env.PI_CODING_AGENT_DIR;
beforeEach(async () => {
	const base = resolve(".local/tmp/storage-controller-tests");
	await mkdir(base, { recursive: true });
	root = await mkdtemp(join(base, "case-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
});
const turn = () => new Promise<void>((r) => setImmediate(r));
async function waitFor(test: () => boolean) {
	const end = Date.now() + 10000;
	while (!test()) {
		if (Date.now() > end) throw Error("startup did not settle");
		await turn();
	}
	await turn();
}
function make(error?: Error) {
	const changes: string[] = [];
	let ready = 0,
		exits = 0;
	const selection = selectLocalStorage(root, true, {});
	const controller = new StorageStartupController({
		selection,
		error,
		userData: join(root, "profile"),
		onChange: (state) => {
			changes.push(state.phase);
		},
		onReady: () => {
			ready++;
		},
		onExit: () => {
			exits++;
		},
	});
	return {
		controller,
		selection,
		changes,
		get ready() {
			return ready;
		},
		get exits() {
			return exits;
		},
	};
}
describe("pre-backend startup preparation", () => {
	it("does not mark ready before an explicit import choice, then resumes from its published receipt", async () => {
		const first = make();
		await mkdir(first.selection.source as string, { recursive: true });
		await writeFile(join(first.selection.source as string, "auth.json"), "{}");
		first.controller.start();
		await waitFor(() => first.controller.state.phase === "choice");
		expect(first.ready).toBe(0);
		expect(await readdir(root)).not.toContain(".percho");
		expect(() => first.controller.act("copy")).toThrow();
		first.controller.act("scan");
		await waitFor(() => first.controller.state.phase === "review");
		first.controller.act("copy");
		await waitFor(() => first.ready === 1);
		const second = make();
		second.controller.start();
		await waitFor(() => second.ready === 1);
		expect(second.controller.state.phase).toBe("ready");
		expect(second.changes).not.toContain("choice");
		expect(second.changes).not.toContain("existing");
		second.controller.launchWorkbench();
		expect(second.controller.state.phase).toBe("launching");
	});
	it("new isolated storage starts empty without asking and existing unmarked storage requires adoption", async () => {
		const first = make();
		first.controller.start();
		await waitFor(() => first.ready === 1);
		await rm(first.selection.target, { recursive: true });
		await mkdir(first.selection.target, { mode: 0o700 });
		await privateDirectory(first.selection.target, true);
		await writeFile(join(first.selection.target, "mine"), "retained");
		const second = make();
		second.controller.start();
		await waitFor(() => second.controller.state.phase === "existing");
		expect(second.ready).toBe(0);
		second.controller.act("adopt");
		await waitFor(() => second.ready === 1);
		expect(await readFile(join(first.selection.target, "mine"), "utf8")).toBe("retained");
	});
	it("shows skipped resource links before importing and preserves them in the receipt", async () => {
		const run = make();
		const source = run.selection.source as string;
		await mkdir(join(source, "skills"), { recursive: true });
		await symlink(join(root, "missing"), join(source, "skills", "broken"));
		await writeFile(join(source, "history"), "history");
		run.controller.start();
		await waitFor(() => run.controller.state.phase === "choice");
		run.controller.act("scan");
		await waitFor(() => run.controller.state.phase === "review");
		expect(run.controller.state.warnings).toEqual([{ path: "skills/broken", reason: "missing-link-target" }]);
		run.controller.act("copy");
		await waitFor(() => run.ready === 1);
		const record = JSON.parse(
			await readFile(join(run.selection.target, ".percho-local-storage.json"), "utf8"),
		);
		expect(record.warnings).toEqual([{ path: "skills/broken", reason: "missing-link-target" }]);
		expect(await readFile(join(run.selection.target, "history"), "utf8")).toBe("history");
	});
	it("a failed scan can return to choice and start fresh without reading the damaged source", async () => {
		const run = make();
		await mkdir(run.selection.source as string, { recursive: true });
		await symlink(join(root, "missing"), join(run.selection.source as string, "auth.json"));
		run.controller.start();
		await waitFor(() => run.controller.state.phase === "choice");
		run.controller.act("scan");
		await waitFor(() => run.controller.state.phase === "error");
		expect(run.controller.state.canReturn).toBe(true);
		run.controller.act("back");
		await waitFor(() => run.controller.state.phase === "choice");
		run.controller.act("empty");
		await waitFor(() => run.ready === 1);
		expect(await readdir(run.selection.target)).not.toContain("auth.json");
	});
	it("invalid bootstrap cannot initialize any data or call ready", async () => {
		const run = make(Error("legacy variable is not accepted"));
		run.controller.start();
		await waitFor(() => run.controller.state.phase === "error");
		expect(run.ready).toBe(0);
		expect(await readdir(root)).toEqual([]);
		run.controller.act("exit");
		expect(run.exits).toBe(1);
	});
	it("bad preferences keep the published copy, retry only fixes references after repair", async () => {
		const run = make();
		await mkdir(run.selection.source as string, { recursive: true });
		await writeFile(join(run.selection.source as string, "history"), "original");
		await mkdir(join(root, "profile"));
		await writeFile(join(root, "profile", "ui-state.json"), "bad");
		run.controller.start();
		await waitFor(() => run.controller.state.phase === "choice");
		run.controller.act("scan");
		await waitFor(() => run.controller.state.phase === "review");
		run.controller.act("copy");
		await waitFor(() => run.controller.state.phase === "error");
		expect(run.ready).toBe(0);
		await writeFile(join(run.selection.target, "new-data"), "must survive retry");
		await writeFile(join(root, "profile", "ui-state.json"), "{}");
		run.controller.act("retry");
		await waitFor(() => run.ready === 1);
		expect(await readFile(join(run.selection.target, "new-data"), "utf8")).toBe("must survive retry");
		expect(await readFile(join(run.selection.source as string, "history"), "utf8")).toBe("original");
	});
});

it("recognizes publication even if releasing the migration lock reports an error", async () => {
	const run = make();
	await mkdir(run.selection.source as string, { recursive: true });
	await writeFile(join(run.selection.source as string, "history"), "original");
	run.controller.start();
	await waitFor(() => run.controller.state.phase === "choice");
	run.controller.act("scan");
	await waitFor(() => run.controller.state.phase === "review");
	const originalLock = lockfile.lock.bind(lockfile);
	const spy = vi.spyOn(lockfile, "lock").mockImplementation(async (path, options) => {
		const release = await originalLock(path, options);
		return async () => {
			await release();
			throw new Error("release acknowledgement failed after publication");
		};
	});
	try {
		run.controller.act("copy");
		await waitFor(() => run.controller.state.phase === "error");
		expect(run.controller.state.canReturn).toBe(false);
		expect(() => run.controller.act("back")).toThrow();
		const marker = join(run.selection.target, ".percho-local-storage.json");
		const published = await readFile(marker, "utf8");
		await writeFile(join(run.selection.target, "new-data"), "must survive");
		run.controller.act("retry");
		await waitFor(() => run.ready === 1);
		expect(await readFile(marker, "utf8")).toBe(published);
		expect(await readFile(join(run.selection.target, "new-data"), "utf8")).toBe("must survive");
	} finally {
		spy.mockRestore();
	}
});

it("retains a failed copy and releases its lock before returning to start fresh", async () => {
	const selection = selectLocalStorage(root, true, {});
	await mkdir(selection.source as string, { recursive: true });
	await writeFile(join(selection.source as string, "history"), "original");
	let ready = false;
	let failCopy = true;
	const controller = new StorageStartupController({
		selection,
		userData: join(root, "profile"),
		onReady: () => {
			ready = true;
		},
		onExit: () => {},
		onChange: (state) => {
			if (failCopy && state.phase === "copying" && state.workPhase === "copy") {
				failCopy = false;
				throw new Error("injected copy failure");
			}
		},
	});
	controller.start();
	await waitFor(() => controller.state.phase === "choice");
	controller.act("scan");
	await waitFor(() => controller.state.phase === "review");
	controller.act("copy");
	await waitFor(() => controller.state.phase === "error");
	const retained = controller.state.recoveryPath;
	expect(retained).toContain(".agent-import-");
	expect(controller.state.canReturn).toBe(true);
	controller.act("back");
	await waitFor(() => controller.state.phase === "choice");
	controller.act("empty");
	await waitFor(() => ready);
	expect(await readdir(retained as string)).toContain("history");
	expect(await readdir(selection.target)).toEqual([".percho-local-storage.json"]);
});

it.each(["source", "other-reserved-root"])(
	"rejects an unresolved %s before offering either initialization",
	async (kind) => {
		const run = make();
		await mkdir(join(root, ".pi"));
		const link = kind === "source" ? (run.selection.source as string) : join(root, ".pi", "agent-dev");
		await symlink(join(root, "missing"), link, process.platform === "win32" ? "junction" : "dir");
		run.controller.start();
		await waitFor(() => run.controller.state.phase === "error");
		expect(run.controller.state.canReturn).toBe(false);
		expect(() => run.controller.act("empty")).toThrow();
		expect(run.ready).toBe(0);
		expect(await readdir(root)).not.toContain(".percho");
	},
);

it("does not silently start fresh when the old source disappears before returning to choice", async () => {
	const run = make();
	await mkdir(run.selection.source as string, { recursive: true });
	await writeFile(join(run.selection.source as string, "settings.json"), "broken");
	run.controller.start();
	await waitFor(() => run.controller.state.phase === "choice");
	run.controller.act("scan");
	await waitFor(() => run.controller.state.phase === "error");
	await rm(run.selection.source as string, { recursive: true });
	run.controller.act("back");
	await waitFor(() => run.controller.state.phase === "choice" || run.ready === 1);
	expect(run.controller.state.phase).toBe("choice");
	expect(run.ready).toBe(0);
	expect(await readdir(root)).not.toContain(".percho");
});

it("requires a new explicit confirmation after a failed copy is rescanned", async () => {
	const run = make();
	await mkdir(run.selection.source as string, { recursive: true });
	run.controller.start();
	await waitFor(() => run.controller.state.phase === "choice");
	run.controller.act("scan");
	await waitFor(() => run.controller.state.phase === "review");
	await writeFile(join(run.selection.source as string, "late-file"), "not previously confirmed");
	run.controller.act("copy");
	await waitFor(() => run.controller.state.phase === "error");
	run.controller.act("retry");
	await waitFor(() => run.controller.state.phase === "review");
	expect(run.ready).toBe(0);
	expect(run.controller.state.totalFiles).toBe(1);
	run.controller.act("copy");
	await waitFor(() => run.ready === 1);
	expect(await readFile(join(run.selection.target, "late-file"), "utf8")).toBe("not previously confirmed");
});

it.each(["before", "after"])(
	"cancels %s publication and restarts from the actual disk state",
	async (boundary) => {
		const selection = selectLocalStorage(root, true, {});
		await mkdir(selection.source as string, { recursive: true });
		await writeFile(join(selection.source as string, "history"), "original");
		let ready = 0;
		let exits = 0;
		const controller = new StorageStartupController({
			selection,
			userData: join(root, "profile"),
			onReady: () => {
				ready++;
			},
			onExit: () => {
				exits++;
			},
			onChange: (state) => {
				if (boundary === "before" && state.phase === "copying" && state.workPhase === "publish")
					controller.act("cancel");
			},
		});
		controller.start();
		await waitFor(() => controller.state.phase === "choice");
		controller.act("scan");
		await waitFor(() => controller.state.phase === "review");
		const original = fsPromises.rename;
		const spy = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
			await original(from, to);
			if (boundary === "after" && to === selection.target) controller.act("cancel");
		});
		try {
			controller.act("copy");
			await waitFor(() => exits === 1);
			expect(ready).toBe(0);
			if (boundary === "before") {
				expect(await readdir(join(root, ".percho"))).not.toContain("agent");
				expect((await readdir(join(root, ".percho"))).some((name) => name.startsWith(".agent-import-"))).toBe(
					true,
				);
			} else {
				const saved = await readFile(join(selection.target, ".percho-local-storage.json"), "utf8");
				const restarted = make();
				restarted.controller.start();
				await waitFor(() => restarted.ready === 1);
				expect(restarted.changes).not.toContain("choice");
				expect(await readFile(join(selection.target, ".percho-local-storage.json"), "utf8")).toBe(saved);
			}
		} finally {
			spy.mockRestore();
		}
	},
);

it("does not offer a new task while a failed migration lock is still held", async () => {
	const run = make();
	await mkdir(run.selection.source as string, { recursive: true });
	await writeFile(join(run.selection.source as string, "history"), "original");
	run.controller.start();
	await waitFor(() => run.controller.state.phase === "choice");
	run.controller.act("scan");
	await waitFor(() => run.controller.state.phase === "review");
	const originalLock = lockfile.lock.bind(lockfile);
	let release: (() => Promise<void>) | undefined;
	const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async (path, options) => {
		release = await originalLock(path, options);
		return async () => {
			throw new Error("lock is still held");
		};
	});
	const originalRename = fsPromises.rename;
	const renameSpy = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (to === run.selection.target) throw new Error("copy publication failed");
		await originalRename(from, to);
	});
	try {
		run.controller.act("copy");
		await waitFor(() => run.controller.state.phase === "error");
		expect(run.controller.state.canReturn).toBe(false);
		expect(run.controller.state.retryable).toBe(false);
		expect(run.controller.state.recoveryPath).toContain(".agent-import-");
		expect(run.controller.state.error).toContain("copy publication failed");
		expect(() => run.controller.act("back")).toThrow();
		expect(() => run.controller.act("retry")).toThrow();
	} finally {
		await release?.();
		lockSpy.mockRestore();
		renameSpy.mockRestore();
	}
});

it("waits for a delayed aborted scan and never lets its result replace the new choice", async () => {
	const run = make();
	const source = run.selection.source as string;
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "history"), "data");
	let enter = () => {};
	let release = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = fsPromises.readdir;
	const spy = vi.spyOn(fsPromises, "readdir").mockImplementation(async (path, ...args) => {
		if (path === source) {
			enter();
			await barrier;
		}
		return original(path, ...args);
	});
	try {
		run.controller.start();
		await waitFor(() => run.controller.state.phase === "choice");
		run.controller.act("scan");
		await entered;
		run.controller.act("back");
		expect(run.controller.state.phase).toBe("scanning");
		expect(() => run.controller.act("empty")).toThrow("busy");
		release();
		await waitFor(() => run.controller.state.phase === "choice");
		expect(run.changes.filter((phase) => phase === "choice")).toHaveLength(2);
		expect(run.changes).not.toContain("review");
		run.controller.act("empty");
		await waitFor(() => run.ready === 1);
		expect(await readdir(run.selection.target)).toEqual([".percho-local-storage.json"]);
	} finally {
		release();
		spy.mockRestore();
	}
});

it("accepts synchronous actions from change callbacks once choice and review are available", async () => {
	const selection = selectLocalStorage(root, true, {});
	await mkdir(selection.source as string, { recursive: true });
	await writeFile(join(selection.source as string, "history"), "data");
	let ready = false;
	const controller = new StorageStartupController({
		selection,
		userData: join(root, "profile"),
		onReady: () => {
			ready = true;
		},
		onExit: () => {},
		onChange: (state) => {
			if (state.phase === "choice") controller.act("scan");
			if (state.phase === "review") controller.act("copy");
		},
	});
	controller.start();
	await waitFor(() => ready);
	expect(await readFile(join(selection.target, "history"), "utf8")).toBe("data");
});

it("exit remains available after publication while the workbench is still starting", async () => {
	const run = make();
	run.controller.start();
	await waitFor(() => run.ready === 1);
	run.controller.act("exit");
	expect(run.exits).toBe(1);
	expect(await readdir(run.selection.target)).toContain(".percho-local-storage.json");
	run.controller.launchWorkbench();
	expect(run.controller.state.phase).toBe("ready");
});

it("never grants workbench access before storage is ready and reports initialization failures without reimporting", async () => {
	const run = make();
	run.controller.launchWorkbench();
	expect(run.controller.state.phase).toBe("inspecting");
	run.controller.start();
	await waitFor(() => run.ready === 1);
	run.controller.failWorkbench(Error("backend initialization failed"));
	expect(run.controller.state).toMatchObject({ phase: "error", retryable: false });
	expect(() => run.controller.act("retry")).toThrow("Restart the application");
});
