/**
 * 确定性动画 GIF 夹具（零依赖、零二进制资产）。
 *
 * 为什么自己造：技术门要验证「动画 GIF 的首帧策略」，就不能依赖传递依赖包里的图片
 * （electron-winstaller 只是可选传递依赖，随时可能消失）。这里按 GIF89a 规范手写一个
 * 2 帧动画：调色板 2 色、LZW 用「每个像素前先发 Clear」的最简合法编码，不增长字典。
 *
 * 产物自证：探针 worker 用 ImageDecoder 报 frameCount，门断言 frameCount > 1，
 * 所以这份夹具本身也被验证（造错了会直接红灯，不会静默通过）。
 */

const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // "GIF89a"

/** LSB-first 位打包 */
function packCodes(codes, codeSize) {
	const bytes = [];
	let buffer = 0;
	let bits = 0;
	for (const code of codes) {
		buffer |= code << bits;
		bits += codeSize;
		while (bits >= 8) {
			bytes.push(buffer & 0xff);
			buffer >>= 8;
			bits -= 8;
		}
	}
	if (bits > 0) bytes.push(buffer & 0xff);
	return bytes;
}

/**
 * 最简合法 LZW：每次发像素前先发 Clear，字典永不增长，码长恒为 minCodeSize+1。
 * （子块长度上限 255，这里像素极少，必然一个子块装得下，但仍按规范切块。）
 */
function lzwBlock(pixelIndexes, minCodeSize) {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	const codes = [];
	for (const pixel of pixelIndexes) {
		codes.push(clearCode, pixel);
	}
	codes.push(endCode);
	const packed = packCodes(codes, minCodeSize + 1);
	const blocks = [minCodeSize];
	for (let offset = 0; offset < packed.length; offset += 255) {
		const chunk = packed.slice(offset, offset + 255);
		blocks.push(chunk.length, ...chunk);
	}
	blocks.push(0x00);
	return blocks;
}

function frame(delayCentiseconds, pixelIndexes) {
	return [
		0x21,
		0xf9,
		0x04,
		0x00, // Graphic Control Extension（无透明、无 disposal）
		delayCentiseconds & 0xff,
		(delayCentiseconds >> 8) & 0xff,
		0x00,
		0x00,
		0x2c,
		0x00,
		0x00,
		0x00,
		0x00, // Image Descriptor：left/top = 0,0
		0x04,
		0x00,
		0x04,
		0x00, // width=4 height=4（LE）
		0x00, // 无局部调色板、非隔行
		...lzwBlock(pixelIndexes, 2),
	];
}

/** 4×4、两帧（全色 0 / 棋盘 0-1）、无限循环的 GIF89a */
export function makeAnimatedGif() {
	const red = [0xff, 0x00, 0x00];
	const blue = [0x00, 0x40, 0xff];
	const bytes = [
		...GIF_HEADER,
		0x04,
		0x00,
		0x04,
		0x00, // 逻辑屏幕 4×4
		0x80, // 有全局调色板；size 字段 0 ⇒ 2^(0+1)=2 个颜色（写 0x81 会声明 4 色 → 解码直接失败）
		0x00,
		0x00, // 背景色索引、像素宽高比
		...red,
		...blue,
		// NETSCAPE2.0 循环扩展：无限循环
		0x21,
		0xff,
		0x0b,
		...Buffer.from("NETSCAPE2.0", "ascii"),
		0x03,
		0x01,
		0x00,
		0x00,
		0x00,
		...frame(20, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		...frame(20, [0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0]),
		0x3b, // Trailer
	];
	return Buffer.from(bytes);
}

export function makeAnimatedGifBase64() {
	return makeAnimatedGif().toString("base64");
}
