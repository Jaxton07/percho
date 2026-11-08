import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type SessionArchiveOptions, SessionArchiveService } from "../src/session/archive";
import type { SessionCatalog } from "../src/session/catalog";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const base = join(repo, ".local/tmp/session-archive-catalog/final-crash");
const bundle = join(base, "crash-child.mjs");
const roots: string[] = [];

// Bundled locally so the child runs the real service and SDK, without a TS loader or an agent.
const childSource = `
import { JsonStore } from "./packages/backend/src/json-store.ts";
import { SessionArchiveService } from "./packages/backend/src/session/archive.ts";
const [root, id, file, point] = process.argv.slice(2);
const pause = () => new Promise(() => { process.send({ point }); });
const originalWrite = JsonStore.prototype.write;
JsonStore.prototype.write = async function(value) {
  const phase = value?.records?.[0]?.phase;
  if (point === "unsubscribe" && phase === "archived-cleanup") await pause();
  await originalWrite.call(this, value);
  if (point === "prepared" && phase === "prepared") await pause();
};
const catalog = {
  verify: async () => [{ status: "present", meta: { sessionId: id, sessionFile: file } }],
  setArchive: async () => {},
};
const service = new SessionArchiveService({
  agentDir: root, catalog: () => catalog, getSession: () => undefined,
  hasPending: () => false, withFile: async (_, operation) => operation(),
  disposeSession: async () => { if (point === "cleanup") await pause(); },
});
await service.init();
await service.archive({ sessionId: id, sessionFile: file, expectedRevision: 0 });
throw new Error("Archive passed the requested waitpoint");
`;

beforeAll(async () => {
	await mkdir(base, { recursive: true });
	await build({
		stdin: { contents: childSource, resolveDir: repo, loader: "ts" },
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile: bundle,
	});
});

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	await rm(bundle, { force: true });
});

it.each(["prepared", "unsubscribe", "cleanup"] as const)(
	"recovers after SIGKILL at %s",
	async (point) => {
		const root = await mkdtemp(join(base, `${point}-`));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: "anthropic",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		manager.appendCustomEntry("channel-subs", { topics: ["news"], cursors: {} });
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing session file");
		const id = manager.getSessionId();
		const child = fork(bundle, [root, id, file, point], {
			env: {
				PATH: process.env.PATH,
				HOME: root,
				TMPDIR: root,
				PI_CODING_AGENT_DIR: root,
				XDG_CONFIG_HOME: root,
				XDG_CACHE_HOME: root,
			},
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
			child.once("exit", (code, signal) => resolveExit({ code, signal }));
			child.once("error", () => resolveExit({ code: null, signal: null }));
		});
		try {
			await new Promise<void>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error(`Waitpoint timed out: ${stderr}`)), 10_000);
				child.once("message", (message) => {
					clearTimeout(timer);
					if ((message as { point?: string }).point !== point) reject(new Error("Wrong waitpoint"));
					else resolveReady();
				});
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				void exited.then(({ code, signal }) => {
					clearTimeout(timer);
					reject(new Error(`Child exited early: ${code} ${signal} ${stderr}`));
				});
			});
			expect(child.kill("SIGKILL")).toBe(true);
			expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		}

		const record = JSON.parse(await readFile(join(root, "session-archive.json"), "utf8")).records[0];
		expect(record.phase).toBe(point === "cleanup" ? "archived-cleanup" : "prepared");
		const entries = SessionManager.open(file).getEntries();
		const last = entries.at(-1);
		if (point === "prepared") {
			expect(last).toMatchObject({ customType: "channel-subs", data: { topics: ["news"], cursors: {} } });
		} else {
			expect(last).toMatchObject({
				customType: "channel-subs",
				data: { topics: [], cursors: {}, archiveOp: record.opId },
			});
		}
		const dispose = vi.fn(async () => {});
		const catalog = {
			verify: async () => [{ status: "present", meta: { sessionId: id, sessionFile: file } }],
			setArchive: async () => {},
		} as unknown as SessionCatalog;
		const options: SessionArchiveOptions = {
			agentDir: root,
			catalog: () => catalog,
			getSession: () => undefined,
			hasPending: () => false,
			disposeSession: dispose,
			withFile: async (_files, operation) => operation(),
		};
		const restarted = new SessionArchiveService(options);
		await restarted.init();
		await expect(restarted.assertOpen(file)).rejects.toThrow();
		if (point === "prepared") {
			expect(await restarted.state(id, file)).toMatchObject({
				phase: "prepared",
				blocked: true,
				archived: false,
			});
			await expect(
				restarted.archive({ sessionId: id, sessionFile: file, expectedRevision: 0 }),
			).rejects.toThrow(/unresolved/);
			expect(await readFile(file, "utf8")).not.toContain(record.opId);
		} else {
			expect(await restarted.state(id, file)).toMatchObject({
				phase: "archived-cleanup",
				blocked: true,
				archived: true,
				cleanupPending: true,
			});
			await restarted.retryCleanup(id, file);
			expect(await restarted.state(id, file)).toMatchObject({ phase: "archived", archived: true });
			await expect(restarted.retryCleanup(id, file)).rejects.toThrow(/No pending/);
			expect(dispose).toHaveBeenCalledOnce();
		}
	},
	15_000,
);
