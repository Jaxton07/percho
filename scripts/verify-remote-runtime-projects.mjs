/** Disposable Linux container only: /work read-only and private /state/v tmpfs. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !entry?.startsWith("/work/"))
	throw new Error("Isolated Linux fixture required");
const exec = promisify(execFile),
	root = "/state/v",
	project = `${root}/project %2F [literal] :12 `;
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const socket = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
const cli = async (command) =>
	JSON.parse((await exec(process.execPath, [entry, command, "--root", root], { timeout: 45000 })).stdout);
await mkdir(`${root}/agent`, { recursive: true, mode: 0o700 });
for (const path of [
	`${project}/.pi/extensions`,
	`${project}/.pi/prompts`,
	`${project}/.pi/skills/remote-skill`,
])
	await mkdir(path, { recursive: true });
await writeFile(`${root}/agent/settings.json`, JSON.stringify({ defaultProjectTrust: "ask" }));
await writeFile(`${project}/remote-only.txt`, "Remote project reference");
await writeFile(
	`${project}/.pi/skills/remote-skill/SKILL.md`,
	"---\nname: remote-skill\ndescription: Remote fixture skill\n---\nREMOTE_SKILL_BODY\n",
);
await writeFile(
	`${project}/.pi/prompts/remote-prompt.md`,
	"---\ndescription: Remote fixture prompt\n---\nREMOTE_PROMPT_BODY\n",
);
await writeFile(
	`${project}/.pi/extensions/resource-marker.ts`,
	`import{writeFileSync}from'node:fs';writeFileSync('${root}/extension-imported','trusted');export default function(){};`,
);
await symlink(project, `${root}/project-link`);
let client, trustRequest;
try {
	await cli("start");
	client = await RuntimeClient.connect(socket, (method, payload) => {
		if (method === "onTrustRequest") trustRequest = payload;
	});
	await client.attach("project-fixture");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	assert.equal(await client.invoke("validateProjectDirectory", { path: project }), await realpath(project));
	assert.equal(await client.invoke("validateProjectDirectory", { path: `${root}/project-link` }), project);
	await assert.rejects(
		client.invoke("validateProjectDirectory", { path: `${project}/remote-only.txt` }),
		/directory/,
	);
	await assert.rejects(client.invoke("validateProjectDirectory", { path: `${root}/missing` }), /ENOENT/);
	await assert.rejects(access(`${root}/missing`));
	const files = await client.invoke("listProjectFiles", { cwd: project });
	assert.ok(files.includes("remote-only.txt"));
	const untrusted = await client.invoke("listSlashCommandsForCwd", { cwd: project });
	assert.equal(
		untrusted.some((command) => command.name === "remote-prompt"),
		false,
	);
	await assert.rejects(access(`${root}/extension-imported`));
	const trusting = client.invoke("ensureProjectTrust", { cwd: project });
	const deadline = Date.now() + 15000;
	while (!trustRequest && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(trustRequest);
	await assert.rejects(access(`${root}/extension-imported`));
	await client.invoke("respondTrust", { requestId: trustRequest.id, answer: 0 });
	assert.equal(await trusting, true);
	const commands = await client.invoke("listSlashCommandsForCwd", { cwd: project });
	assert.ok(commands.some((command) => command.name === "remote-prompt"));
	const skill = commands.find((command) => command.skillId);
	assert.ok(skill?.skillId);
	await access(`${root}/extension-imported`);
	const session = await client.invoke("createSession", { options: { cwd: project } });
	assert.equal(session.cwd, project);
	const resources = await client.invoke("getLoadedResources", { sessionId: session.sessionId });
	assert.ok(resources.skills.some((skill) => skill.name === "remote-skill"));
	await rm(`${project}/.pi/skills/remote-skill/SKILL.md`);
	await assert.rejects(
		client.invoke("prompt", {
			sessionId: session.sessionId,
			text: "Keep missing skill draft",
			document: {
				version: 1,
				parts: [
					{ type: "skill", id: skill.skillId, label: skill.name },
					{ type: "text", text: " Keep missing skill draft" },
				],
			},
		}),
		/ENOENT/,
	);
	await rm(`${project}/remote-only.txt`);
	await assert.rejects(
		client.invoke("prompt", {
			sessionId: session.sessionId,
			text: "Keep missing file draft",
			document: {
				version: 1,
				parts: [
					{ type: "file", path: "remote-only.txt" },
					{ type: "text", text: " Keep missing file draft" },
				],
			},
		}),
		/ENOENT/,
	);
	await rename(project, `${root}/moved-project`);
	await assert.rejects(
		client.invoke("prompt", { sessionId: session.sessionId, text: "Keep missing directory draft" }),
		/ENOENT/,
	);
	const history = await client.invoke("getSessionMessages", { sessionId: session.sessionId });
	assert.equal(
		history.some((message) => message.role === "user"),
		false,
	);
	client.close();
	client = undefined;
	assert.equal((await cli("stop")).stopped, true);
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			literalPaths: true,
			symlinkCanonical: true,
			missingDirectoryNotCreated: true,
			trustBeforeExecutableResources: true,
			remoteFilesSkillsAndPrompts: true,
			staleResourcesRejectedBeforePrompt: true,
		}),
	);
} finally {
	client?.close();
	await cli("stop").catch(() => {});
}
