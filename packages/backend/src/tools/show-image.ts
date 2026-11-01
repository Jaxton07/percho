import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DisplayImage, ReferenceImage } from "@percho/shared";
import { Type } from "typebox";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 9;
const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};
const showImageParams = Type.Object({
	paths: Type.Array(
		Type.String({
			description:
				"Path to an image file: absolute, relative to the working directory, or starting with ~ (home directory)",
		}),
		{ minItems: 1, maxItems: MAX_IMAGES, description: `Image file paths to display (1-${MAX_IMAGES})` },
	),
});
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;
export function resolveShowImagePath(rawPath: string, cwd: string, home: string = homedir()): string {
	let path = rawPath.replace(UNICODE_SPACES, " ");
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}
export interface ShowImageDetails {
	paths: string[];
	images: DisplayImage[];
}
export interface ShowImagePublisher {
	assert: () => void;
	publish: (bytes: Uint8Array, mimeType: string) => Promise<ReferenceImage>;
}
export type ShowImagePublisherFactory = (ownerSessionId: string, sessionFile?: string) => ShowImagePublisher;

/** stat只做快筛；实际读取最多limit+1，防文件在stat后增长导致无限分配。 */
async function readBounded(path: string, signal?: AbortSignal): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const before = await handle.stat({ bigint: true });
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= MAX_BYTES) {
			if (signal?.aborted) throw new Error("Image read cancelled");
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - total));
			const result = await handle.read(buffer, 0, buffer.length, total);
			if (!result.bytesRead) break;
			chunks.push(buffer.subarray(0, result.bytesRead));
			total += result.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (total <= MAX_BYTES && (before.size !== after.size || before.mtimeNs !== after.mtimeNs))
			throw new Error("Image changed while reading");
		return Buffer.concat(chunks, total);
	} finally {
		await handle.close();
	}
}

/** 默认保留内联兼容；生产适配器只有在媒体生命周期闭环后才注入所有者租约。 */
export function makeShowImageTool(
	publisherFor?: ShowImagePublisherFactory,
): ToolDefinition<typeof showImageParams> {
	return defineTool({
		name: "show_image",
		label: "show_image",
		annotations: { readOnlyHint: true, openWorldHint: false },
		description:
			"Display image files to the user in the chat UI. Use ONLY when the user explicitly asks to see images, or when showing visual content is clearly necessary (e.g. screenshots or plots you just produced). Do NOT call this for every image you read. When showing multiple related images, pass them ALL in one call's paths array instead of calling repeatedly. The images are shown to the user but NOT added to your context — if you need to see the image content yourself, use the read tool instead.",
		promptSnippet: "show_image({paths})",
		parameters: showImageParams,
		execute: async (_id, params, signal, _update, ctx): Promise<AgentToolResult<ShowImageDetails>> => {
			if (!params.paths.length || params.paths.length > MAX_IMAGES)
				throw new Error("show_image: 1-9 images are required");
			// 在任何await前捕获真正的SDK来源与打开代次，不能读取结束后才猜activeSession。
			const publisher = publisherFor?.(
				ctx.sessionManager.getSessionId(),
				ctx.sessionManager.getSessionFile(),
			);
			publisher?.assert();
			const files = [];
			for (const raw of params.paths) {
				const path = resolveShowImagePath(raw, ctx.cwd),
					mimeType = MIME_BY_EXT[extname(path).toLowerCase()];
				if (!mimeType)
					throw new Error(
						`show_image: unsupported image type for "${raw}" (supported: png, jpg, jpeg, gif, webp, bmp)`,
					);
				const info = await stat(path).catch(() => {
					throw new Error(`show_image: file not found: ${path}`);
				});
				if (!info.isFile()) throw new Error(`show_image: not a file: ${path}`);
				if (info.size > MAX_BYTES)
					throw new Error(
						`show_image: image too large (${Math.ceil(info.size / 1024 / 1024)}MB > 10MB limit): ${raw}`,
					);
				files.push({ raw, path, mimeType });
			}
			const images: DisplayImage[] = [];
			for (const file of files) {
				publisher?.assert();
				const bytes = await readBounded(file.path, signal);
				if (bytes.byteLength > MAX_BYTES)
					throw new Error(`show_image: image too large (max 10MB): ${file.raw}`);
				publisher?.assert();
				images.push(
					publisher
						? await publisher.publish(bytes, file.mimeType)
						: { data: bytes.toString("base64"), mimeType: file.mimeType },
				);
			}
			return {
				content: [
					{
						type: "text",
						text:
							images.length === 1
								? `Image displayed to the user in the chat: ${params.paths[0]}`
								: `${images.length} images displayed to the user in the chat: ${params.paths.join(", ")}`,
					},
				],
				details: { paths: [...params.paths], images },
			};
		},
	});
}
