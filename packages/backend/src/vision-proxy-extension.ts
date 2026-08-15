import { createHash } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { VisionConfig } from "@percho/shared";
import { createLogger } from "./log";
import { describeImage, VisionClientError } from "./vision-client";
import { resolveVisionKey, VISION_RETRY_TTL_MS, type VisionConfigService } from "./vision-config";

const log = createLogger("vision-proxy");

/** 同一 LLM 调用内最多 4 张图并发识别（串行太慢，无限并发会打爆限流） */
const MAX_CONCURRENCY = 4;

/** 失败占位缓存有效期：期间复用失败结果不打扰重试风暴，过期后下次调用自动重试 */
type CacheEntry =
	| { state: "done"; description: string }
	| { state: "failed"; error: string; ts: number }
	| { state: "pending"; promise: Promise<string> };

interface ImageBlockLike {
	type: "image";
	data: string;
	mimeType?: string;
}

function isImageBlock(block: unknown): block is ImageBlockLike {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "image" &&
		typeof (block as { data?: unknown }).data === "string" &&
		(block as { data: string }).data.length > 0
	);
}

function hashImage(image: ImageBlockLike): string {
	return createHash("sha256")
		.update(`${image.mimeType ?? ""}:${image.data}`)
		.digest("hex");
}

/** 简单并发限流器（max 个槽位，超出排队） */
function createLimiter(max: number) {
	let active = 0;
	const waiters: (() => void)[] = [];
	return async function run<T>(fn: () => Promise<T>): Promise<T> {
		if (active >= max) await new Promise<void>((resolve) => waiters.push(resolve));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			waiters.shift()?.();
		}
	};
}

export interface VisionProxyOptions {
	/** 配置服务（每次调用实时读取，保存即生效） */
	configService: VisionConfigService;
}

/**
 * 内置视觉代理扩展：纯文本模型的外挂图像识别。
 * context 钩子（每次 LLM 调用前触发、不落盘）把上下文里的 image block
 * 原位替换为「视觉模型识别的文本描述」，让不支持图片输入的模型也能处理截图。
 *
 * 触发条件（全部满足才工作）：开关开 + 有 key + 当前模型 input 不含 image + 上下文有图。
 * 原生多模态模型直通零成本；识别失败降级为占位文本，对话不中断
 * （context 钩子契约：不得 throw，异常时原样放行）。
 *
 * 已知限制：compaction 的摘要请求不经 context 钩子（SDK 直接 convertToLlm），
 * 文本模型 + 含图历史触发压缩时仍可能报 provider 图像错误（现状已有，后续项）。
 */
export function makeVisionProxyExtension(options: VisionProxyOptions): InlineExtension {
	return {
		name: "vision-proxy",
		factory: (pi) => {
			/** 图片 sha256 → 描述（会话内闭包：同图首轮识别一次，工具循环复用） */
			const cache = new Map<string, CacheEntry>();
			const limit = createLimiter(MAX_CONCURRENCY);

			pi.on("context", async (event, ctx) => {
				try {
					const config = await options.configService.getConfig();
					if (!config.enabled) return;
					if (!resolveVisionKey(config.apiKey)) return;
					// 原生多模态模型直通（ctx.model.input 含 image）
					if (ctx.model?.input?.includes("image")) return;
					if (ctx.signal?.aborted) return;

					// 收集上下文中全部图片（按首次出现顺序去重）
					const ordered: { hash: string; image: ImageBlockLike }[] = [];
					const seen = new Set<string>();
					for (const message of event.messages) {
						const content = (message as { content?: unknown }).content;
						if (!Array.isArray(content)) continue;
						for (const block of content) {
							if (!isImageBlock(block)) continue;
							const hash = hashImage(block);
							if (seen.has(hash)) continue;
							seen.add(hash);
							ordered.push({ hash, image: block });
						}
					}
					if (ordered.length === 0) return;

					// 并发识别（limiter 内部限流；同图 pending 复用在途 promise）
					const language = options.configService.getLanguage();
					const results = await Promise.all(
						ordered.map(async ({ hash, image }) => {
							try {
								return { hash, description: await ensureDescription(hash, image, config, language) };
							} catch (err) {
								const error = err instanceof Error ? err.message : String(err);
								log.warn("vision describe failed", { error: error.slice(0, 200) });
								return { hash, error };
							}
						}),
					);
					const byHash = new Map(results.map((r) => [r.hash, r]));
					// 编号按首次出现顺序（1 起），同一张图多次引用同号
					const numberByHash = new Map(ordered.map((o, i) => [o.hash, i + 1]));

					const label = language === "zh" ? "图像" : "Image";
					const descWord = language === "zh" ? "描述" : "description";
					const failWord = language === "zh" ? "识别失败" : "recognition failed";

					let changed = false;
					const messages = event.messages.map((message) => {
						const content = (message as { content?: unknown }).content;
						if (!Array.isArray(content) || !content.some(isImageBlock)) return message;
						changed = true;
						const newContent = content.map((block) => {
							if (!isImageBlock(block)) return block;
							const n = numberByHash.get(hashImage(block)) ?? 0;
							const result = byHash.get(hashImage(block));
							const text = result?.description
								? `[[${label} ${n} ${descWord}]\n${result.description}]`
								: `[[${label} ${n} ${failWord}: ${result?.error ?? "unknown"}]]`;
							return { type: "text", text };
						});
						return { ...message, content: newContent };
					});
					if (!changed) return;
					return { messages: messages as typeof event.messages };
				} catch (err) {
					// context 钩子契约：不得 throw，任何异常原样放行
					log.warn("vision proxy skipped", { error: err instanceof Error ? err.message : String(err) });
					return undefined;
				}
			});

			/** 识别（带缓存：done 直接回、pending 复用在途、失败 TTL 后重试） */
			async function ensureDescription(
				hash: string,
				image: ImageBlockLike,
				config: VisionConfig,
				language: "zh" | "en",
			): Promise<string> {
				const cached = cache.get(hash);
				if (cached) {
					if (cached.state === "done") return cached.description;
					if (cached.state === "pending") return cached.promise;
					if (Date.now() - cached.ts < VISION_RETRY_TTL_MS) throw new VisionClientError(cached.error);
				}
				const promise = limit(() =>
					describeImage(
						{ config, language },
						{
							data: image.data,
							mimeType: image.mimeType ?? "image/png",
						},
					),
				).then(
					(description) => {
						cache.set(hash, { state: "done", description });
						return description;
					},
					(err: unknown) => {
						const error = err instanceof Error ? err.message : String(err);
						cache.set(hash, { state: "failed", error, ts: Date.now() });
						throw err;
					},
				);
				cache.set(hash, { state: "pending", promise });
				return promise;
			}
		},
	};
}
