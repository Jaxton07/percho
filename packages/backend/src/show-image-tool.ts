import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 单图上限：details 里带 base64 会进 jsonl 与模型无关，但过大文件拖慢 IPC/渲染 */
const MAX_BYTES = 10 * 1024 * 1024;
/** 单次调用最多发图数量（对话区单行可容纳，防滥发） */
const MAX_IMAGES = 9;

/** 与 read 工具的图片类型白名单一致（按扩展名识别） */
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
		{
			minItems: 1,
			maxItems: MAX_IMAGES,
			description: `Image file paths to display (1-${MAX_IMAGES})`,
		},
	),
});

/** unicode 空格（macOS 截图名常带窄空格   等）归一为普通空格 */
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;

/** 输入路径规整：~ 展开为 home、unicode 空格归一、相对路径按 cwd resolve。
 *  SDK 的 resolvePath 未公开导出（exports 只露 ./client 等），此处自行实现最小子集 */
export function resolveShowImagePath(rawPath: string, cwd: string, home: string = homedir()): string {
	let p = rawPath.replace(UNICODE_SPACES, " ");
	if (p === "~") p = home;
	else if (p.startsWith("~/")) p = join(home, p.slice(2));
	return isAbsolute(p) ? p : resolve(cwd, p);
}

/** show_image 工具的结构化详情（tool_execution_end 的 result.details；模型不可见，进 jsonl） */
export interface ShowImageDetails {
	paths: string[];
	images: { data: string; mimeType: string }[];
}

/**
 * 内置 show_image 工具：把一组图片显示到桌面端对话区。
 * 图片只走 details（UI 渲染 + jsonl 持久化），不进模型上下文 ——
 * 模型要看图内容应使用 read 工具。
 */
export function makeShowImageTool(): ToolDefinition<typeof showImageParams> {
	return {
		name: "show_image",
		label: "Show Image",
		description:
			"Display image files to the user in the chat UI. Use ONLY when the user explicitly asks to see images, or when showing visual content is clearly necessary (e.g. screenshots or plots you just produced). Do NOT call this for every image you read. When showing multiple related images, pass them ALL in one call's paths array instead of calling repeatedly. The images are shown to the user but NOT added to your context — if you need to see the image content yourself, use the read tool instead.",
		promptSnippet: "show_image({paths})",
		parameters: showImageParams,
		execute: async (
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<ShowImageDetails>> => {
			const images: ShowImageDetails["images"] = [];
			for (const rawPath of params.paths) {
				const path = resolveShowImagePath(rawPath, ctx.cwd);
				const mimeType = MIME_BY_EXT[extname(path).toLowerCase()];
				if (!mimeType) {
					throw new Error(
						`show_image: unsupported image type for "${rawPath}" (supported: png, jpg, jpeg, gif, webp, bmp)`,
					);
				}
				const info = await stat(path).catch(() => {
					throw new Error(`show_image: file not found: ${path}`);
				});
				if (!info.isFile()) throw new Error(`show_image: not a file: ${path}`);
				if (info.size > MAX_BYTES) {
					throw new Error(
						`show_image: image too large (${Math.ceil(info.size / 1024 / 1024)}MB > ${MAX_BYTES / 1024 / 1024}MB limit): ${rawPath}`,
					);
				}
				images.push({ data: (await readFile(path)).toString("base64"), mimeType });
			}
			const count = images.length;
			return {
				content: [
					{
						type: "text",
						text:
							count === 1
								? `Image displayed to the user in the chat: ${params.paths[0]}`
								: `${count} images displayed to the user in the chat: ${params.paths.join(", ")}`,
					},
				],
				details: { paths: [...params.paths], images },
			};
		},
	};
}
