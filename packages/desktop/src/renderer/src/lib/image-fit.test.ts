import { describe, expect, it } from "vitest";
import {
	base64Size,
	fitDimensions,
	IMAGE_MAX_BASE64_BYTES,
	pickSmallestWithinLimit,
	shrinkDimensions,
	withinImageLimits,
} from "./image-fit";

describe("base64Size", () => {
	it("按 4/3 放大并补齐（与真实编码一致）", () => {
		expect(base64Size(0)).toBe(0);
		expect(base64Size(3)).toBe(4);
		expect(base64Size(4)).toBe(8);
		expect(base64Size(3_539_000)).toBe(4_718_668);
	});
});

describe("withinImageLimits", () => {
	it("尺寸与体积都在限内 → true", () => {
		expect(withinImageLimits({ width: 2000, height: 1338, bytes: 300_000 })).toBe(true);
	});
	it("超尺寸（任一边）→ false", () => {
		expect(withinImageLimits({ width: 2001, height: 100, bytes: 1000 })).toBe(false);
		expect(withinImageLimits({ width: 100, height: 2122, bytes: 1000 })).toBe(false);
	});
	it("体积超 4.5MB base64 → false（边界取 <）", () => {
		const justUnder = Math.floor((IMAGE_MAX_BASE64_BYTES / 4) * 3);
		expect(withinImageLimits({ width: 100, height: 100, bytes: justUnder - 3 })).toBe(true);
		expect(withinImageLimits({ width: 100, height: 100, bytes: justUnder + 3 })).toBe(false);
	});
});

describe("fitDimensions", () => {
	it("只缩不放：已在限内原样返回", () => {
		expect(fitDimensions(800, 600)).toEqual({ width: 800, height: 600 });
	});
	it("按最长边等比缩到上限（用户实测的 2122x1420 → 2000x1338）", () => {
		expect(fitDimensions(2122, 1420)).toEqual({ width: 2000, height: 1338 });
	});
	it("竖图按高缩", () => {
		expect(fitDimensions(1200, 4000)).toEqual({ width: 600, height: 2000 });
	});
	it("极端长条不会缩到 0", () => {
		expect(fitDimensions(9000, 3).height).toBe(1);
	});
});

describe("shrinkDimensions", () => {
	it("按比例缩且不小于 1px", () => {
		expect(shrinkDimensions(2000, 1000)).toEqual({ width: 1700, height: 850 });
		expect(shrinkDimensions(2, 1, 0.5)).toEqual({ width: 1, height: 1 });
	});
});

describe("pickSmallestWithinLimit", () => {
	const big = { bytes: IMAGE_MAX_BASE64_BYTES, tag: "too-big" };
	it("都不在限内 → null", () => {
		expect(pickSmallestWithinLimit([big, big])).toBeNull();
	});
	it("在限内取体积最小的（镜像 SDK 的 PNG/JPEG 取更小）", () => {
		const picked = pickSmallestWithinLimit([
			{ bytes: 3_000_000, tag: "png" },
			{ bytes: 300_000, tag: "jpeg" },
		]);
		expect(picked?.tag).toBe("jpeg");
	});
	it("忽略超限的候选，只用合法的那份", () => {
		const picked = pickSmallestWithinLimit([big, { bytes: 1_000_000, tag: "png" }]);
		expect(picked?.tag).toBe("png");
	});
	it("空列表 → null", () => {
		expect(pickSmallestWithinLimit([])).toBeNull();
	});
});
