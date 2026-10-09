/**
 * 缩略图 worker（真实产物：Vite 打包成独立 chunk，同源 URL 加载）。
 *
 * 职责只有一件：base64 → Blob → createImageBitmap → OffscreenCanvas → PNG Blob。
 * - 等比缩到最长边 ≤ maxSide（**不放大**），输出统一 PNG（保透明）
 * - `imageOrientation: "from-image"`：阶段 0 实测 EXIF Orientation=6 会被自动摆正
 *   （不传选项时浏览器默认同样是 from-image，这里显式写出来是为了意图可见）
 * - 动画 GIF 只取首帧（`createImageBitmap` 的行为，阶段 0 实测 316 帧只给首帧）
 * - bitmap 在成功/失败两条路径上都 close()
 * - **不**回传 base64、不做像素 alpha 扫描（那是阶段 0 探针为了取证才做的重复解码）
 *
 * 刻意不 import 任何 React / store / SDK 模块，只 import 常量与类型。
 */
/// <reference lib="webworker" />
import { THUMBNAIL_MAX_SIDE } from "./constants";
import type { ThumbnailRequest, ThumbnailResponse } from "./thumbnail-protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function renderThumbnail(request: ThumbnailRequest): Promise<ThumbnailResponse> {
	const { requestId, image, maxSide } = request;
	try {
		const bytes = decodeBase64(image.data);
		const source = new Blob([bytes], { type: image.mimeType });
		const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
		try {
			const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
			const width = Math.max(1, Math.round(bitmap.width * scale));
			const height = Math.max(1, Math.round(bitmap.height * scale));
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext("2d");
			if (!context) throw new Error("OffscreenCanvas 2d 上下文不可用");
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = "high";
			context.drawImage(bitmap, 0, 0, width, height);
			const blob = await canvas.convertToBlob({ type: "image/png" });
			return { requestId, ok: true, blob, width, height };
		} finally {
			bitmap.close();
		}
	} catch (error) {
		return { requestId, ok: false, error: describe(error) };
	}
}

scope.onmessage = (event: MessageEvent<ThumbnailRequest>) => {
	const request = event.data;
	const maxSide = Number.isFinite(request?.maxSide) ? request.maxSide : THUMBNAIL_MAX_SIDE;
	void renderThumbnail({ ...request, maxSide }).then((response) => scope.postMessage(response));
};
