/**
 * 主线程 ↔ 缩略图 worker 的消息协议（**只有类型**，运行时零成本，worker 与主线程共用）。
 *
 * 纪律：请求只带**既有**的 `ImageInput` 引用（结构化克隆会复制 base64，这是这条链路上
 * 唯一不可避免的一次拷贝；不再额外 decode/编码/预热）；响应只回 Blob 与几何，
 * **绝不把 base64 回传**（spec：禁止 base64 双份）。
 */
import type { ImageInput } from "@percho/shared";

export interface ThumbnailRequest {
	requestId: number;
	image: ImageInput;
	maxSide: number;
}

export type ThumbnailResponse =
	| { requestId: number; ok: true; blob: Blob; width: number; height: number }
	| { requestId: number; ok: false; error: string };
