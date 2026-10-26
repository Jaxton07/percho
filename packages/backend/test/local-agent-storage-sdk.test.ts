import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { initializeLocalStorage, inspectLocalStorage } from "../src/storage/local-storage";
import { selectLocalStorage, validateStorageSelection } from "../src/storage/path-policy";
import { localSessionPaths } from "../src/storage/session-paths";

let root = "",
	backend: PiBackend | undefined;
const originalAgent = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
	await backend?.shutdown();
	backend = undefined;
	if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgent;
	if (root) await rm(root, { recursive: true, force: true });
});
it("real SDK opens imported parent/child, forks, renames and deletes only the new files", async () => {
	const base = resolve(".local/tmp/local-storage-sdk");
	await mkdir(base, { recursive: true });
	root = await mkdtemp(join(base, "case-"));
	const selection = await validateStorageSelection(selectLocalStorage(root, true, {})),
		source = selection.source as string,
		project = join(root, "project");
	await mkdir(project);
	await mkdir(source, { recursive: true });
	await writeFile(
		join(source, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "isolated-fixture",
					models: [
						{
							id: "fixture",
							name: "Fixture",
							contextWindow: 32000,
							maxTokens: 1000,
							input: ["text"],
							reasoning: false,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await writeFile(
		join(source, "settings.json"),
		JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", packages: [], extensions: [] }),
	);
	const create = (directory: string) => {
		const m = SessionManager.create(project, directory);
		m.appendMessage({ role: "user", content: "fixture-user", timestamp: 1 });
		m.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "fixture-response" }],
			provider: "fixture",
			model: "fixture",
			api: "openai-completions",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} satisfies Message);
		return m;
	};
	const parent = create(join(source, "sessions", "project")),
		child = create(join(source, "sessions-subagents", "project"));
	const parentFile = parent.getSessionFile() as string,
		childFile = child.getSessionFile() as string,
		originalParent = await readFile(parentFile),
		originalChild = await readFile(childFile);
	const record = await initializeLocalStorage(await inspectLocalStorage(selection), "copy");
	process.env.PI_CODING_AGENT_DIR = selection.target;
	backend = new PiBackend({
		localSessionPaths: localSessionPaths(record, selection.legacyRoots),
		projectTrust: false,
		webFetch: false,
		permissionGates: false,
	});
	await backend.init();
	const p = await backend.openSession(parentFile);
	expect(p.sessionFile).toContain(selection.target);
	expect(p.sessionId).toBe(parent.getSessionId());
	expect(JSON.stringify(await backend.getSessionMessages(p.sessionId))).toContain("fixture-response");
	const c = await backend.openSession(childFile);
	expect(c.readOnly).toBe(true);
	await expect(backend.prompt(c.sessionId, "must not send")).rejects.toThrow("read-only");
	await backend.setSessionName(p.sessionId, "renamed-in-Percho");
	expect(await backend.exportSession(p.sessionId, "jsonl")).toContain("renamed-in-Percho");
	const fork = await backend.forkSession(p.sessionId, { text: "fixture-response" });
	expect(fork.sessionFile).toContain(selection.target);
	await backend.deleteSession(p.sessionId, parentFile);
	expect(await readFile(parentFile)).toEqual(originalParent);
	expect(await readFile(childFile)).toEqual(originalChild);
	await expect(readFile(p.sessionFile as string)).rejects.toHaveProperty("code", "ENOENT");
}, 30000);
