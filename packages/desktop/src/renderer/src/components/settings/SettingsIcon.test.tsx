import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsIcon } from "../icons/SettingsIcon";

describe("设置图标", () => {
	it("插头和包裹采用不同的冻结图形及共同线条样式", () => {
		const plug = renderToStaticMarkup(<SettingsIcon name="plug" />);
		const box = renderToStaticMarkup(<SettingsIcon name="package" size={20} className="test" />);
		expect(plug).toContain('viewBox="0 0 24 24"');
		expect(plug).toContain('stroke-width="1.55"');
		expect(plug).toContain('width="17"');
		expect(plug).toContain("M8 2v5m8-5v5");
		expect(box).toContain("m12 2 10 5v10");
		expect(box).toContain('width="20"');
		expect(box).toContain('class="test"');
	});
});
