/**
 * 历史图片技术探针 worker（夹具 + 探针，**不是产品代码**，由 scripts/check-history-images.mjs 加载）。
 *
 * 为什么放在库里而不是 .local：清目录 / 新 clone 后脚本仍然能跑；不依赖任何依赖包里的图片或模块。
 *
 * 目的：在**真实 dev / build 运行时的 CSP 与加载机制**下验证
 *   1) worker 本身能不能被创建（classic / module × blob / same-origin 路径）
 *   2) worker 内能不能完成 base64 → Blob → createImageBitmap → OffscreenCanvas → PNG Blob 全链
 *   3) 各格式（PNG / JPEG / WebP / 透明 PNG / EXIF JPEG / 动画 GIF）的解码、方向与 alpha 行为
 *   4) 缩略图吞吐与首次结果时延（够不够撑住 48 slots 的可见优先调度）
 *
 * 刻意不 import 任何仓库模块，classic 与 module 两种加载方式共用同一份源码。
 */

function post(message) {
	self.postMessage(message);
}

function b64ToBytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function decodeBitmap(base64, mimeType, resizeTo, imageOrientation) {
	const bytes = b64ToBytes(base64);
	const options = {};
	// 显式传 null 表示“不传这个选项”，用于确认浏览器默认（规范默认 = from-image）与显式值一致
	if (imageOrientation !== null) options.imageOrientation = imageOrientation ?? "from-image";
	if (resizeTo) {
		options.resizeWidth = resizeTo.width;
		options.resizeHeight = resizeTo.height;
		options.resizeQuality = "high";
	}
	return await createImageBitmap(new Blob([bytes], { type: mimeType }), options);
}

/** 单张缩图：解码 → 缩放 → PNG 编码，返回精简几何与耗时（不回传 base64） */
async function thumb(msg) {
	const mark = {};
	const t0 = performance.now();
	b64ToBytes(msg.base64); // 计入 base64 解码成本
	mark.base64Ms = performance.now() - t0;

	let bitmap;
	try {
		bitmap = await decodeBitmap(msg.base64, msg.mimeType, msg.resizeTo ?? null, msg.imageOrientation);
	} catch (error) {
		return { ok: false, stage: "createImageBitmap", error: String(error) };
	}
	mark.decodeMs = performance.now() - t0 - mark.base64Ms;

	const srcWidth = bitmap.width;
	const srcHeight = bitmap.height;
	const target = msg.resizeTo
		? { width: bitmap.width, height: bitmap.height }
		: (() => {
				const scale = Math.min(1, (msg.maxSide ?? 384) / Math.max(srcWidth, srcHeight));
				return {
					width: Math.max(1, Math.round(srcWidth * scale)),
					height: Math.max(1, Math.round(srcHeight * scale)),
				};
			})();

	let blob;
	let minAlpha = null;
	try {
		const canvas = new OffscreenCanvas(target.width, target.height);
		const ctx = canvas.getContext("2d");
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(bitmap, 0, 0, target.width, target.height);
		mark.drawMs = performance.now() - t0 - mark.decodeMs - mark.base64Ms;
		// 缩图后的 alpha 是否还在（透明 PNG 样本的断言依据）
		const pixels = ctx.getImageData(0, 0, target.width, target.height).data;
		minAlpha = 255;
		for (let i = 3; i < pixels.length; i += 4) {
			if (pixels[i] < minAlpha) minAlpha = pixels[i];
		}
		blob = await canvas.convertToBlob({ type: "image/png" });
		mark.encodeMs = performance.now() - t0 - mark.drawMs - mark.decodeMs - mark.base64Ms;
	} finally {
		bitmap.close();
	}

	return {
		ok: true,
		via: msg.resizeTo ? "bitmap-resize-option" : "canvas-draw",
		srcWidth,
		srcHeight,
		width: target.width,
		height: target.height,
		blobBytes: blob.size,
		blobType: blob.type,
		minAlpha,
		ms: {
			total: performance.now() - t0,
			base64: mark.base64Ms,
			decode: mark.decodeMs,
			draw: mark.drawMs,
			encode: mark.encodeMs,
		},
		// 只把缩图 Blob 回传（结构化克隆 Blob 不复制字节）；页面侧用它建 blob: URL 验 CSP
		blob,
	};
}

/** 动画 GIF 的首帧策略：createImageBitmap 只给第一帧，ImageDecoder 能报总帧数 */
async function gifInfo(msg) {
	const bytes = b64ToBytes(msg.base64);
	const out = { bytes: bytes.length };
	try {
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/gif" }), {
			imageOrientation: "from-image",
		});
		out.bitmapWidth = bitmap.width;
		out.bitmapHeight = bitmap.height;
		bitmap.close();
	} catch (error) {
		out.bitmapError = String(error);
	}
	if (typeof ImageDecoder !== "undefined") {
		try {
			const decoder = new ImageDecoder({ data: bytes, type: "image/gif" });
			await decoder.completed;
			await decoder.tracks.ready;
			const track = decoder.tracks.selectedTrack;
			out.frameCount = track.frameCount;
			out.animated = track.animated;
			out.repetitionCount = track.repetitionCount;
			const first = await decoder.decode({ frameIndex: 0 });
			out.firstFrameWidth = first.image.displayWidth;
			out.firstFrameHeight = first.image.displayHeight;
			first.image.close();
			decoder.close();
		} catch (error) {
			out.decoderError = String(error);
		}
	}
	return out;
}

self.onmessage = async (event) => {
	const msg = event.data ?? {};
	try {
		if (msg.op === "echo") {
			post({
				id: msg.id,
				ok: true,
				echo: {
					scope: typeof self === "object" && typeof window === "undefined" ? "worker" : "page",
					hasCreateImageBitmap: typeof createImageBitmap === "function",
					hasOffscreenCanvas: typeof OffscreenCanvas === "function",
					hasImageDecoder: typeof ImageDecoder !== "undefined",
					hardwareConcurrency: navigator.hardwareConcurrency,
				},
			});
			return;
		}
		if (msg.op === "thumb") {
			post({ id: msg.id, ok: true, result: await thumb(msg) });
			return;
		}
		if (msg.op === "gifinfo") {
			post({ id: msg.id, ok: true, result: await gifInfo(msg) });
			return;
		}
		post({ id: msg.id, ok: false, error: `unknown op: ${msg.op}` });
	} catch (error) {
		post({ id: msg.id, ok: false, error: String(error?.stack ?? error) });
	}
};
