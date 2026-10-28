import type { UpstreamModelInfo, UpstreamModelsInput } from "@percho/shared";
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
	request: (input: UpstreamModelsInput) => Promise<UpstreamModelInfo[]>,
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
		async load(input: UpstreamModelsInput) {
			const current = ++generation;
			publish({ models: null, loading: true, error: null });
			try {
				const models = await request(input);
				if (current === generation) publish({ models, loading: false, error: null });
			} catch (error) {
				if (current === generation)
					publish({ models: null, loading: false, error: errText(error) ?? String(error) });
			}
		},
	};
}
