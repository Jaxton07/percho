import type { UpstreamModelInfo, UpstreamModelsInput, UpstreamModelsResult } from "@percho/shared";
import { errText } from "../../../lib/error-text";

export interface UpstreamModelsState {
	models: UpstreamModelInfo[] | null;
	loading: boolean;
	error: string | null;
}

export const EMPTY_UPSTREAM_MODELS_STATE: UpstreamModelsState = {
	models: null,
	loading: false,
	error: null,
};

/** 每次改连接配置或重新获取都换代；旧请求的成功、失败和结束状态均不得覆盖新表单。 */
export function createUpstreamModelsLoader(
	request: (input: UpstreamModelsInput) => Promise<UpstreamModelsResult>,
	publish: (state: UpstreamModelsState) => void,
) {
	let generation = 0;
	return {
		invalidate() {
			generation++;
			publish(EMPTY_UPSTREAM_MODELS_STATE);
		},
		dispose() {
			generation++;
		},
		/** 返回本次结果（含实际使用的 baseUrl）；被新请求取代或失败时返回 null，调用方不得回填 */
		async load(input: UpstreamModelsInput): Promise<UpstreamModelsResult | null> {
			const current = ++generation;
			publish({ models: null, loading: true, error: null });
			try {
				const result = await request(input);
				if (current !== generation) return null;
				publish({ models: result.models, loading: false, error: null });
				return result;
			} catch (error) {
				if (current === generation)
					publish({ models: null, loading: false, error: errText(error) ?? String(error) });
				return null;
			}
		},
	};
}
