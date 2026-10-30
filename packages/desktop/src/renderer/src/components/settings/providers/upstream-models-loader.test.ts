import type { UpstreamModelsInput, UpstreamModelsResult } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { createUpstreamModelsLoader, EMPTY_UPSTREAM_MODELS_STATE } from "./upstream-models-loader";

const input: UpstreamModelsInput = { baseUrl: "https://example.invalid/v1", api: "openai-completions" };
/** 后端返回模型清单 + 实际可用的 baseUrl（探测可能补成 /v1） */
const result = (models: { id: string }[], baseUrl = input.baseUrl): UpstreamModelsResult => ({
	models,
	baseUrl,
});
function deferred() {
	let resolve!: (value: UpstreamModelsResult) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<UpstreamModelsResult>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("上游候选请求的归属", () => {
	it("配置变化立即清掉已有候选和错误", async () => {
		const publish = vi.fn();
		const request = vi
			.fn()
			.mockResolvedValueOnce(result([{ id: "old" }]))
			.mockRejectedValueOnce(new Error("failed"));
		const loader = createUpstreamModelsLoader(request, publish);
		await loader.load(input);
		expect(publish).toHaveBeenLastCalledWith({ models: [{ id: "old" }], loading: false, error: null });
		loader.invalidate();
		expect(publish).toHaveBeenLastCalledWith(EMPTY_UPSTREAM_MODELS_STATE);
		await loader.load(input);
		expect(publish).toHaveBeenLastCalledWith({ models: null, loading: false, error: "failed" });
		loader.invalidate();
		expect(publish).toHaveBeenLastCalledWith(EMPTY_UPSTREAM_MODELS_STATE);
	});

	it.each(["success", "failure"])(
		"配置变化后旧请求的 %s 不得覆盖新请求或提前结束 loading",
		async (outcome) => {
			const old = deferred();
			const next = deferred();
			const publish = vi.fn();
			const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
			const loader = createUpstreamModelsLoader(request, publish);
			const first = loader.load(input);
			loader.invalidate();
			const changed = { ...input, baseUrl: "https://new.invalid/v1", apiKey: "fixture-only" };
			const second = loader.load(changed);
			const count = publish.mock.calls.length;
			if (outcome === "success") old.resolve(result([{ id: "stale" }]));
			else old.reject(new Error("stale failure"));
			await first;
			expect(publish).toHaveBeenCalledTimes(count);
			expect(publish).toHaveBeenLastCalledWith({ models: null, loading: true, error: null });
			next.resolve(result([{ id: "new" }]));
			await second;
			expect(request).toHaveBeenLastCalledWith(changed);
			expect(publish).toHaveBeenLastCalledWith({ models: [{ id: "new" }], loading: false, error: null });
		},
	);

	it("同配置重复请求乱序完成时，旧结果不能覆盖新结果", async () => {
		const old = deferred();
		const next = deferred();
		const publish = vi.fn();
		const loader = createUpstreamModelsLoader(
			vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise),
			publish,
		);
		const first = loader.load(input);
		const second = loader.load(input);
		next.resolve(result([]));
		await second;
		old.resolve(result([{ id: "stale" }]));
		await first;
		expect(publish).toHaveBeenLastCalledWith({ models: [], loading: false, error: null });
	});

	it("把实际可用的基址回传给调用方；被新请求取代时返回 null（不覆盖新表单）", async () => {
		const first = deferred();
		const publish = vi.fn();
		const request = vi.fn().mockReturnValueOnce(first.promise);
		const loader = createUpstreamModelsLoader(request, publish);
		const pending = loader.load(input);
		loader.invalidate();
		first.resolve(result([{ id: "m" }], "https://relay.example.com/v1"));
		await expect(pending).resolves.toBeNull();

		const fixed = result([{ id: "m" }], "https://relay.example.com/v1");
		request.mockResolvedValueOnce(fixed);
		await expect(
			loader.load({ baseUrl: "https://relay.example.com", api: "openai-completions" }),
		).resolves.toEqual(fixed);
	});

	it("表单卸载后不再发布结果", async () => {
		const pending = deferred();
		const publish = vi.fn();
		const loader = createUpstreamModelsLoader(() => pending.promise, publish);
		const work = loader.load(input);
		loader.dispose();
		publish.mockClear();
		pending.resolve(result([{ id: "late" }]));
		await work;
		expect(publish).not.toHaveBeenCalled();
	});
});
