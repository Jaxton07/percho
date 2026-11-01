import { isNewerVersion, npmSourceToPackageName } from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("npmSourceToPackageName", () => {
	it("剥掉版本后缀", () => {
		expect(npmSourceToPackageName("npm:pi-lens@4.4.7")).toBe("pi-lens");
	});

	it("无版本后缀时原样返回", () => {
		expect(npmSourceToPackageName("npm:pi-lens")).toBe("pi-lens");
	});

	it("兼容 scoped 包名", () => {
		expect(npmSourceToPackageName("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(npmSourceToPackageName("npm:@scope/pkg")).toBe("@scope/pkg");
	});

	it("非 npm: 源返回 null", () => {
		expect(npmSourceToPackageName("github:foo/bar")).toBeNull();
	});
});

describe("isNewerVersion", () => {
	it("主版本更高", () => {
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
	});

	it("补丁号更高", () => {
		expect(isNewerVersion("4.4.7", "4.4.6")).toBe(true);
	});

	it("相同版本不算更新", () => {
		expect(isNewerVersion("0.9.11", "0.9.11")).toBe(false);
	});

	it("本地更新时不提示（避免 latest tag 滞后误报）", () => {
		expect(isNewerVersion("4.4.6", "4.4.7")).toBe(false);
	});

	it("遵循预发布版本顺序", () => {
		expect(isNewerVersion("1.2.0-beta.1", "1.1.9")).toBe(true);
		expect(isNewerVersion("1.2.0", "1.2.0-beta.1")).toBe(true);
		expect(isNewerVersion("1.2.0-beta.10", "1.2.0-beta.2")).toBe(true);
		expect(isNewerVersion("1.2.0-beta.1", "1.2.0")).toBe(false);
	});

	it("无效版本不提示更新，构建信息不参与比较", () => {
		expect(isNewerVersion("1.2", "1.2.0")).toBe(false);
		expect(isNewerVersion("1.2.1", "1.2")).toBe(false);
		expect(isNewerVersion("", "1.0.0")).toBe(false);
		expect(isNewerVersion("2.0.0", "invalid")).toBe(false);
		expect(isNewerVersion("1.2.0+build.9", "1.2.0+build.1")).toBe(false);
	});
});
