import { buildVisionPrompt, type VisionConfig } from "@percho/shared";
import { resolveVisionKey } from "./config";

/** 单图识别超时（截图识别通常 <10s，长图/复杂 OCR 留余量） */
export const VISION_TIMEOUT_MS = 45_000;
/** 识别输出 token 上限（OCR 长图需要空间） */
const MAX_TOKENS = 4096;

/** 16×16 白色 PNG（连接测试用；Qwen3.7-VL 要求宽高 > 10px，1×1 会被算法层 400 拒） */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR42mP4TyJgGNUwqmH4agAAr639H23ooMoAAAAASUVORK5CYII=";

export interface VisionClientParams {
	config: VisionConfig;
	language: "zh" | "en";
	/** 外部中止信号（agent run abort 时级联取消识别） */
	signal?: AbortSignal;
}

export class VisionClientError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "VisionClientError";
	}
}

function endpointOf(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** baseUrl 解析失败返回空串（不因此拖挂识别链路） */
function hostnameOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return "";
	}
}

/** 智谱系端点才带 thinking 开关（OpenAI 官方等会拒收未知字段） */
function isBigModel(baseUrl: string): boolean {
	return /bigmodel\.cn$/i.test(hostnameOf(baseUrl));
}

/** 阿里 DashScope 兼容端点：思考开关是顶层 enable_thinking（非智谱的 thinking.type） */
function isDashScope(baseUrl: string): boolean {
	return /dashscope\.aliyuncs\.com$/i.test(hostnameOf(baseUrl));
}

/**
 * host 专属思考开关：识别转述/ping 都不需要深思考，关掉更快。
 * 仅智谱带 thinking.type、仅 DashScope 带顶层 enable_thinking；
 * Qwen3 混合思考模型在 DashScope 非流式调用若默认开思考会报错，必须显式关。
 */
function applyThinkingSwitch(baseUrl: string, body: Record<string, unknown>): void {
	if (isBigModel(baseUrl)) {
		body.thinking = { type: "disabled" };
	} else if (isDashScope(baseUrl)) {
		body.enable_thinking = false;
	}
}

async function postChat(params: VisionClientParams, body: Record<string, unknown>): Promise<string> {
	const key = resolveVisionKey(params.config.apiKey);
	if (!key) throw new VisionClientError("API key not configured");
	let response: Response;
	try {
		response = await fetch(endpointOf(params.config.baseUrl), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: params.signal
				? AbortSignal.any([params.signal, AbortSignal.timeout(VISION_TIMEOUT_MS)])
				: AbortSignal.timeout(VISION_TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new VisionClientError(`vision model request timed out (${VISION_TIMEOUT_MS / 1000}s)`);
		}
		if (err instanceof DOMException && err.name === "AbortError") {
			throw new VisionClientError("vision model request aborted");
		}
		throw new VisionClientError(
			`vision model request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!response.ok) {
		const raw = await response.text().catch(() => "");
		let message = raw.slice(0, 300);
		try {
			const parsed = JSON.parse(raw) as { error?: { message?: string } };
			if (parsed.error?.message) message = parsed.error.message;
		} catch {
			// 非 JSON 错误体，用原文
		}
		throw new VisionClientError(`HTTP ${response.status}: ${message}`, response.status);
	}
	const data = (await response.json().catch(() => null)) as {
		choices?: { message?: { content?: unknown } }[];
	} | null;
	const content = data?.choices?.[0]?.message?.content;
	const text = typeof content === "string" ? content.trim() : "";
	if (!text) throw new VisionClientError("vision model returned empty content");
	return text;
}

/** 识别单张图片 → 文本描述（data 为纯 base64，不含 data URL 前缀） */
export async function describeImage(
	params: VisionClientParams,
	image: { data: string; mimeType: string },
): Promise<string> {
	const body: Record<string, unknown> = {
		model: params.config.model,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: `data:${image.mimeType || "image/png"};base64,${image.data}` },
					},
					{ type: "text", text: buildVisionPrompt(params.language) },
				],
			},
		],
		max_tokens: MAX_TOKENS,
	};
	applyThinkingSwitch(params.config.baseUrl, body);
	return postChat(params, body);
}

/** 连通性测试：16×16 png + 极短 prompt 实调（过模型最小尺寸校验） */
export async function pingVision(params: VisionClientParams): Promise<string> {
	const body: Record<string, unknown> = {
		model: params.config.model,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` },
					},
					{ type: "text", text: "Reply with exactly: OK" },
				],
			},
		],
		max_tokens: 16,
	};
	applyThinkingSwitch(params.config.baseUrl, body);
	return postChat(params, body);
}
