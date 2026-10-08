import type { ImageInput } from "@percho/shared";
import {
	fitDimensions,
	IMAGE_JPEG_QUALITIES,
	IMAGE_SHRINK_ROUNDS,
	pickSmallestWithinLimit,
	shrinkDimensions,
	withinImageLimits,
} from "./image-fit";

/**
 * 附件图片在**粘贴/选择时**就预处理好（见 lib/image-fit.ts 说明）：能直接用的原样送，
 * 超规格的缩到 2000px / 4.5MB base64 以内，让发送路径上的 SDK 归一化走快路径（~0.8–1.1s → ~20-40ms）。
 *
 * 失败一律**退回原图**（SDK 自己会处理，最坏等于今天的行为），绝不因为预处理失败而丢图。
 */

/** 读成 data URL 并剥掉前缀，得到 SDK 要的裸 base64 */
function readBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = typeof reader.result === "string" ? reader.result : "";
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
		reader.readAsDataURL(blob);
	});
}

function canvasFor(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
	if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

async function toBlob(
	canvas: OffscreenCanvas | HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob | null> {
	if (canvas instanceof OffscreenCanvas) {
		try {
			return await canvas.convertToBlob({ type, quality });
		} catch {
			return null;
		}
	}
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 按目标尺寸重绘（Lanczos 级别的浏览器高质量缩放） */
function drawScaled(source: ImageBitmap, width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
	const canvas = canvasFor(width, height);
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
	if (!ctx) return canvas;
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(source, 0, 0, width, height);
	return canvas;
}

/**
 * 预处理一张附件：返回可直接送去 prompt 的 {data, mimeType}。
 * - 尺寸/体积都在限内 → 原图原样（不重编码）
 * - 否则缩到限内：先 PNG 与 JPEG(q80) 取更小的（与 SDK 同策略，截图通常 JPEG 更小）；
 *   两者都超限 → 依次降 JPEG 质量；还超 → 缩像素再来一轮
 * - 解码或编码失败 / 压不下去 → 原图原样
 */
export async function prepareImageAttachment(file: File): Promise<ImageInput> {
	const mimeType = file.type || "image/png";
	// 原图 base64 **惰性读**：需要缩图时不必先弄一份原始大字符串（那是白花的内存与时间）
	let rawData: string | null = null;
	const raw = async (): Promise<ImageInput> => {
		rawData ??= await readBase64(file);
		return { data: rawData, mimeType };
	};
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		// HEIC 等浏览器解不了的格式：原样交给 SDK（它有转 PNG 的兜底）
		return raw();
	}
	try {
		if (withinImageLimits({ width: bitmap.width, height: bitmap.height, bytes: file.size })) return raw();

		let { width, height } = fitDimensions(bitmap.width, bitmap.height);
		for (let round = 0; round < IMAGE_SHRINK_ROUNDS; round += 1) {
			const canvas = drawScaled(bitmap, width, height);
			const picked = await encodeWithinLimit(canvas);
			if (picked) return picked;
			const next = shrinkDimensions(width, height);
			if (next.width === width && next.height === height) break;
			({ width, height } = next);
		}
		return raw();
	} catch {
		return raw();
	} finally {
		bitmap.close?.();
	}
}

/** 一轮编码：PNG/q80 取更小；都超限则依次降质试 JPEG（镜像 SDK 的编码策略） */
async function encodeWithinLimit(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<ImageInput | null> {
	const candidates: { bytes: number; blob: Blob; mimeType: string }[] = [];
	const png = await toBlob(canvas, "image/png");
	if (png) candidates.push({ bytes: png.size, blob: png, mimeType: "image/png" });
	const jpeg = await toBlob(canvas, "image/jpeg", 0.8);
	if (jpeg) candidates.push({ bytes: jpeg.size, blob: jpeg, mimeType: "image/jpeg" });
	const picked = pickSmallestWithinLimit(candidates);
	if (picked) return { data: await readBase64(picked.blob), mimeType: picked.mimeType };

	for (const quality of IMAGE_JPEG_QUALITIES) {
		const lower = await toBlob(canvas, "image/jpeg", quality / 100);
		if (!lower) continue;
		const candidate = { bytes: lower.size, blob: lower, mimeType: "image/jpeg" };
		if (pickSmallestWithinLimit([candidate]))
			return { data: await readBase64(lower), mimeType: "image/jpeg" };
	}
	return null;
}
