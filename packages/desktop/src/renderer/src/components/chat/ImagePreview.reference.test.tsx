// @vitest-environment happy-dom
import {
	type DisplayImage,
	environmentEntityKey,
	type ImageInput,
	type ReferenceImage,
} from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { imageInvalidationListenerCount, notifyImageInvalidation } from "./history-image/image-invalidation";
import { ImagePreviewOverlay } from "./ImagePreview";

const image = (ownerSessionId: string): ReferenceImage => ({
	kind: "reference",
	ownerSessionId,
	id: "entry:real:show:0",
	revision: "v1",
	mimeType: "image/png",
});
const data: ImageInput = { data: "AQID", mimeType: "image/png" };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const revoke = vi.fn();
const create = vi.fn();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
	create.mockReturnValue("blob:test");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	expect(imageInvalidationListenerCount()).toBe(0);
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
describe("预览引用的来源与生命周期", () => {
	it("远端身份换代撤销原图预览；其它环境/owner事件不误伤", async () => {
		const environment = { kind: "ssh" as const, connectionId: "ssh", environmentId: "remote" },
			owner = environmentEntityKey(environment, "session");
		await act(async () =>
			root.render(
				<ImagePreviewOverlay image={image(owner)} onClose={() => {}} resolveImage={async () => data} />,
			),
		);
		expect(create).toHaveBeenCalledTimes(1);
		expect(imageInvalidationListenerCount()).toBe(1);
		await act(async () => {
			notifyImageInvalidation({ environment: { kind: "local" } });
			notifyImageInvalidation({ ownerSessionId: "other" });
		});
		expect(revoke).not.toHaveBeenCalled();
		expect(document.querySelector("[data-image-preview] img")).not.toBeNull();
		await act(async () => notifyImageInvalidation({ environment }));
		expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:test");
		expect(document.querySelector("[data-image-preview] img")).toBeNull();
	});
	it("删除owner后旧读取虽迟到也不能创建新URL", async () => {
		let finish!: (input: ImageInput) => void;
		await act(async () =>
			root.render(
				<ImagePreviewOverlay
					image={image("source")}
					onClose={() => {}}
					resolveImage={() =>
						new Promise((resolve) => {
							finish = resolve;
						})
					}
				/>,
			),
		);
		await act(async () => notifyImageInvalidation({ ownerSessionId: "source" }));
		await act(async () => finish(data));
		expect(create).not.toHaveBeenCalled();
		expect(document.querySelector("[data-image-preview] img")).toBeNull();
	});
	it("切会话时迟到结果不串图，只解析当前图片，关闭撤销URL", async () => {
		const first = image("first");
		const second = image("second");
		const pending = new Map<DisplayImage, (input: ImageInput) => void>();
		const resolveImage = vi.fn(
			(ref: DisplayImage) => new Promise<ImageInput>((resolve) => pending.set(ref, resolve)),
		);
		await act(async () =>
			root.render(<ImagePreviewOverlay images={[first]} onClose={() => {}} resolveImage={resolveImage} />),
		);
		await act(async () =>
			root.render(<ImagePreviewOverlay images={[second]} onClose={() => {}} resolveImage={resolveImage} />),
		);
		await act(async () => pending.get(first)?.(data));
		expect(create).not.toHaveBeenCalled();
		expect(document.querySelector("[data-image-preview] img")).toBeNull();
		await act(async () => pending.get(second)?.(data));
		expect(document.querySelector("[data-image-preview] img")?.getAttribute("src")).toBe("blob:test");
		expect(resolveImage.mock.calls.map(([ref]) => ref)).toEqual([first, second]);
		await act(async () => root.render(null));
		expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:test");
	});
	it("内联预览仍原样使用原图；未绑定引用明确占位", async () => {
		await act(async () => root.render(<ImagePreviewOverlay image={data} onClose={() => {}} />));
		expect(document.querySelector("[data-image-preview] img")?.getAttribute("src")).toBe(
			"data:image/png;base64,AQID",
		);
		await act(async () =>
			root.render(<ImagePreviewOverlay image={image("bound-source-required")} onClose={() => {}} />),
		);
		expect(document.querySelector("[data-image-preview] img")).toBeNull();
		expect(document.querySelector("[data-image-preview]")?.textContent).toContain("message.imageLoadError");
	});
});
