/** 视觉代理（vision proxy）跨进程类型：纯文本模型的外挂图像识别（默认智谱 GLM-4.6V-Flash） */

/** 默认外挂视觉模型（免费，OpenAI 兼容 chat/completions） */
export const DEFAULT_VISION_MODEL = "glm-4.6v-flash";
/** 默认 baseUrl（不含 /chat/completions 后缀） */
export const DEFAULT_VISION_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

/** 服务商预设（设置页一键切换 baseUrl/model；key 获取入口在面板文案提示） */
export interface VisionPreset {
	id: "zhipu" | "qwen" | "custom";
	/** baseUrl 不含 /chat/completions 后缀 */
	baseUrl: string;
	model: string;
}

/** 内置视觉服务商：智谱免费版（高峰易 429）与阿里 Qwen（付费但极便宜、限流宽松） */
export const VISION_PRESETS: VisionPreset[] = [
	{ id: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6v-flash" },
	{ id: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-flash" },
];

/** 按 baseUrl+model 反查预设 id；不匹配任何预设返回 "custom" */
export function matchVisionPreset(baseUrl: string, model: string): VisionPreset["id"] {
	const hit = VISION_PRESETS.find((p) => p.baseUrl === baseUrl.trim() && p.model === model.trim());
	return hit?.id ?? "custom";
}

/** 持久化配置（userData/vision.json；apiKey 支持 $ENV_VAR 引用，绝不回传渲染层） */
export interface VisionConfig {
	enabled: boolean;
	apiKey: string;
	baseUrl: string;
	model: string;
}

/** 渲染层视图：key 只给存在性 */
export interface VisionConfigInfo {
	enabled: boolean;
	hasKey: boolean;
	baseUrl: string;
	model: string;
	/** 识别描述语言（跟随界面语言，backend 内存态） */
	language: "zh" | "en";
}

/** 保存输入：apiKey 留空 = 保持不变；clearApiKey 优先于 apiKey */
export interface VisionSaveInput {
	enabled?: boolean;
	apiKey?: string;
	clearApiKey?: boolean;
	baseUrl?: string;
	model?: string;
}

/** 连接测试结果 */
export interface VisionTestResult {
	ok: boolean;
	/** 失败原因 / 成功时为模型响应摘要 */
	message: string;
}

/** 构建识别 prompt：让视觉模型输出一段供文本推理模型使用的图片描述 */
export function buildVisionPrompt(language: "zh" | "en"): string {
	if (language === "zh") {
		return [
			"你是视觉识别代理。请详细描述这张图片的内容，描述将被另一个文本大模型作为上下文使用。",
			"要求：",
			"1. 图中如有文字（OCR），完整转录并尽量保留排版结构（表格/代码/列表）",
			"2. 如是 UI 截图，说明界面类型、可见的关键元素与布局",
			"3. 如是图表，提取数据与趋势",
			"4. 客观描述，不做推测性评论",
			"直接输出描述内容，不要寒暄。",
		].join("\n");
	}
	return [
		"You are a vision recognition proxy. Describe this image in detail; your description will be used as context by another text-only LLM.",
		"Requirements:",
		"1. If the image contains text (OCR), transcribe it fully, preserving layout structure (tables/code/lists)",
		"2. If it is a UI screenshot, state the interface type and the key visible elements and layout",
		"3. If it is a chart, extract data and trends",
		"4. Be objective; no speculative commentary",
		"Output the description directly, no greetings.",
	].join("\n");
}
