import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectLocalStorage } from "../../../backend/src/storage/path-policy";
import { privateDirectory } from "../../../backend/src/storage/private-directory";
import { StorageStartupController } from "./storage-startup-controller";

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
	let ready = 0,
		exits = 0;
	const selection = selectLocalStorage(root, true, {});
	const controller = new StorageStartupController({
		selection,
		error,
		userData: join(root, "profile"),
		onChange: () => {},
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
		first.controller.act("copy");
		await waitFor(() => first.ready === 1);
		const second = make();
		second.controller.start();
		await waitFor(() => second.ready === 1);
		expect(second.controller.state.phase).toBe("ready");
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

it("exit remains available after publication while the workbench is still starting", async () => {
	const run = make();
	run.controller.start();
	await waitFor(() => run.ready === 1);
	run.controller.act("exit");
	expect(run.exits).toBe(1);
	expect(await readdir(run.selection.target)).toContain(".percho-local-storage.json");
});
