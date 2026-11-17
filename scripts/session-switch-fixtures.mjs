#!/usr/bin/env node
import { randomUUID } from "node:crypto";
/** 合成夹具只写仓库 .local/tmp/session-switch-diagnostics，不读取真实会话或凭证。 */
import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { suiteRoot } from "./performance/paths.mjs";

const root = suiteRoot(
	resolve(import.meta.dirname, ".."),
	"switch",
	".local/tmp/session-switch-diagnostics",
	"PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT",
);
const cwd = join(root, "project");
const agent = join(root, "agent");
await mkdir(root, { recursive: true, mode: 0o700 });
if ((await realpath(root)) !== root) throw new Error("Fixture root must not be a symbolic link");
for (const directory of [cwd, agent, join(agent, "sessions")]) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory)
		throw new Error("Fixture directory must not be a symbolic link");
}
async function publish(file, content) {
	const staged = `${file}.${randomUUID()}.staging`;
	await writeFile(staged, content, { mode: 0o600, flag: "wx" });
	await rename(staged, file);
}
let seed = 142;
function makeImage() {
	const png = new PNG({ width: 384, height: 322 });
	for (let i = 0; i < png.data.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			png.data[i + c] = seed & 255;
		}
		png.data[i + 3] = 255;
	}
	return { mimeType: "image/png", data: PNG.sync.write(png).toString("base64") };
}
const manifest = [];
for (const name of ["screenshots", "text", "long-text", "large-turn", "branches"]) {
	const id = `switch-diagnostic-${name}`;
	const timestamp = "2026-01-01T00:00:00.000Z";
	const lines = [{ type: "session", version: 3, id, timestamp, cwd }];
	let parentId = null;
	let sequence = 0;
	const append = (message, parent = parentId) => {
		const entry = {
			type: "message",
			id: `e${sequence++}`,
			parentId: parent,
			timestamp,
			message: { timestamp: sequence, ...message },
		};
		lines.push(entry);
		parentId = entry.id;
		return entry.id;
	};
	const rounds = name === "long-text" ? 5000 : name === "large-turn" ? 1 : 500;
	for (let i = 0; i < rounds; i++) {
		const user = append({ role: "user", content: [{ type: "text", text: `Synthetic task ${i}` }] });
		append({
			role: "assistant",
			content: [
				{
					type: "text",
					text:
						name === "large-turn"
							? "Synthetic output. ".repeat(1024 * 256)
							: `Synthetic response ${i}. ${"data ".repeat(20)}`,
				},
			],
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "openai-completions",
			provider: "synthetic",
			model: "synthetic",
		});
		if ((name === "screenshots" || name === "text") && i % 8 === 0) {
			append({
				role: "assistant",
				content: [
					{ type: "toolCall", id: `t${i}`, name: "show_image", arguments: { paths: ["synthetic.png"] } },
				],
				api: "openai-completions",
				provider: "synthetic",
				model: "synthetic",
				stopReason: "toolUse",
			});
			append({
				role: "toolResult",
				toolCallId: `t${i}`,
				toolName: "show_image",
				content: [{ type: "text", text: "Synthetic screenshot" }],
				isError: false,
				details: { images: name === "screenshots" ? [makeImage()] : [], paths: ["synthetic.png"] },
			});
		}
		if (name === "branches" && i % 10 === 0) {
			append(
				{
					role: "assistant",
					content: [{ type: "text", text: "Synthetic alternate branch" }],
					stopReason: "error",
					errorMessage: "Synthetic failure",
				},
				user,
			);
		}
	}
	const content = `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const file = join(agent, "sessions", `${name}.jsonl`);
	await publish(file, content);
	manifest.push({ name, file, bytes: Buffer.byteLength(content) });
}
await publish(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("Synthetic fixtures prepared in .local/tmp/session-switch-diagnostics (not user data).");
