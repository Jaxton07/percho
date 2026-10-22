import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { InlineExtension, ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
	type ComposerDocument,
	composerDocumentModelText,
	composerDocumentText,
	parseComposerDocument,
	readComposerDocument,
} from "@percho/shared";

const secret = randomBytes(32);
const marker = `\n<!--percho-input-${randomBytes(16).toString("hex")}:`;
const bridges = new WeakMap<ResourceLoader, ComposerInputBridge>();

export function skillResourceId(path: string): string {
	return createHash("sha256").update(resolve(path)).digest("hex");
}

interface Submission {
	document: ComposerDocument;
	definitions: string;
}

function signature(text: string, payload: string): string {
	return createHmac("sha256", secret).update(text).update("\0").update(payload).digest("hex");
}

function encode(text: string, submission: Submission): string {
	const modelText = submission.definitions ? `${text}\n\n${submission.definitions}` : text;
	const payload = Buffer.from(JSON.stringify(submission.document)).toString("base64url");
	return `${modelText}${marker}${payload}:${signature(modelText, payload)}-->`;
}

/** Only this process's authenticated transport is recognized; ordinary pasted text is untouched. */
export function decodeComposerTransport(text: string): { text: string; document: ComposerDocument } | null {
	const start = text.lastIndexOf(marker);
	if (start < 0) return null;
	const end = text.indexOf("-->", start);
	if (end < 0) throw new Error("Incomplete composer transport");
	const [payload, digest] = text.slice(start + marker.length, end).split(":");
	const before = text.slice(0, start);
	if (!payload || digest !== signature(before, payload)) throw new Error("Invalid composer transport");
	return {
		text: before + text.slice(end + 3), // SDK image hints may follow the transport.
		document: parseComposerDocument(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))),
	};
}

export function composerQueueDocument(text: string): ComposerDocument | undefined {
	return decodeComposerTransport(text)?.document;
}

export function composerQueueText(text: string): string {
	const document = composerQueueDocument(text);
	return document ? composerDocumentText(document) : text;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((b) => b?.type === "text")
				.map((b) => b.text ?? "")
				.join("")
		: "";
}

/** Outbound copies only: keep the actual SDK message/content authoritative for requests and JSONL. */
export function projectComposerMessage<T>(message: T): T {
	const raw = message as { role?: string; content?: unknown; perchoInput?: unknown };
	if (raw?.role !== "user") return message;
	const transported = decodeComposerTransport(textContent(raw.content));
	const document = raw.perchoInput === undefined ? transported?.document : readComposerDocument(raw);
	if (!document) return message;
	const images = Array.isArray(raw.content) ? raw.content.filter((b) => b?.type === "image") : [];
	return {
		...message,
		content: [{ type: "text", text: composerDocumentText(document) }, ...images],
		perchoInput: document,
	};
}

export function createComposerInputBridge(): ComposerInputBridge {
	return new ComposerInputBridge();
}

export function bindComposerInputBridge(loader: ResourceLoader, bridge: ComposerInputBridge) {
	bridges.set(loader, bridge);
}

export function composerInputBridge(loader: ResourceLoader): ComposerInputBridge | undefined {
	return bridges.get(loader);
}

export class ComposerInputBridge {
	private busy = false;
	private current: Submission | undefined;
	readonly extension: InlineExtension = {
		name: "percho-composer-input",
		factory: (pi) => {
			pi.on("input", (event) => {
				if (event.source !== "rpc" || !this.current) return { action: "continue" };
				return { action: "transform", text: encode(event.text, this.current), images: event.images };
			});
			pi.on("message_end", (event, ctx) => {
				if (event.message.role !== "user") return;
				try {
					const decoded = decodeComposerTransport(textContent(event.message.content));
					if (!decoded) return;
					const blocks = Array.isArray(event.message.content) ? event.message.content : [];
					return {
						message: {
							...event.message,
							content: [
								{ type: "text" as const, text: decoded.text },
								...blocks.filter((b) => b.type !== "text"),
							],
							perchoInput: decoded.document,
						},
					};
				} catch (error) {
					// Handler exceptions alone are swallowed by the SDK. Abort and replace the damaged payload.
					void ctx.abort();
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return {
						message: {
							...event.message,
							content: [{ type: "text" as const, text: "[Invalid composer input]" }],
						},
					};
				}
			});
		},
	};

	/** A preflight guard, not a running-message queue: callers release after the SDK acceptance callback. */
	async accept<T>(
		loader: ResourceLoader,
		raw: ComposerDocument | undefined,
		invoke: (text?: string) => Promise<T>,
	): Promise<T> {
		if (this.busy) throw new Error("Another input is still being accepted for this session");
		this.busy = true;
		try {
			if (raw) {
				const document = parseComposerDocument(raw);
				const skills = loader.getSkills().skills;
				const unique = new Map<string, string>();
				for (const part of document.parts) {
					if (part.type !== "skill" || unique.has(part.id)) continue;
					const skill = skills.find((s) => skillResourceId(s.filePath) === part.id);
					if (!skill) throw new Error(`Skill is unavailable: ${part.label}`);
					const source = await readFile(skill.filePath, "utf8");
					const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
					const attributes = Object.entries({
						id: part.id,
						name: skill.name,
						baseDir: skill.baseDir,
						sha256: createHash("sha256").update(source).digest("hex"),
					})
						.map(
							([key, value]) =>
								`${key}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`,
						)
						.join(" ");
					unique.set(part.id, `<skill ${attributes}>\n${body}\n</skill>`);
				}
				this.current = {
					document,
					definitions: unique.size
						? `<referenced_skills>\n${[...unique.values()].join("\n\n")}\n</referenced_skills>`
						: "",
				};
				return await invoke(composerDocumentModelText(document));
			}
			return await invoke();
		} finally {
			this.current = undefined;
			this.busy = false;
		}
	}
}
