import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ACP_STATUS_TOOL,
	buildStatusReport,
	COMPRESS_TOOL,
	type CompressionCore,
	type CompressionState,
	type Config,
	type CoreMessage,
	collectBlockContent,
	defaultCountTokens,
	parseCompressInput,
	SEARCH_CONTEXT_TOOL,
} from "acp-kernel";
import { Type } from "typebox";

/**
 * ACP 四工具（T4，spec D3）：全部经扩展 `pi.registerTool` 注册（纯上下文操作，
 * 无文件/命令副作用，不走 PermissionGate）。参数 schema 一律拍平单 object
 * （AGENTS.md：openai-completions 对顶层 anyOf 400）。compress 的宽容解析用内核
 * `parseCompressInput`（字符串 JSON / 单对象 / startId↔startRef 拼写都收）。
 */

export interface AcpToolDeps {
	core: CompressionCore;
	/** 当前模型窗口下的 kernel config（contextWindow 变化时重算） */
	getConfig: (ctx: ExtensionContext) => Config;
	/**
	 * 锁内访问共享 state（context 钩子与工具 execute 串行；并行工具调用防竞态）：
	 * 现场从 sessionManager 取 entries 派生 coreMessages，fn 返回新 state 时落盘。
	 */
	withAcpState: <T>(
		ctx: ExtensionContext,
		fn: (snapshot: {
			state: CompressionState;
			coreMessages: CoreMessage[];
			config: Config;
		}) => Promise<{ state?: CompressionState; value: T }>,
	) => Promise<T>;
}

/** 拍平单 object schema（导出供测试断言：严禁顶层 anyOf） */
export const compressParams = Type.Object({
	content: Type.Array(
		Type.Object({
			startId: Type.String({ description: "mNNNNN ref at the start of the range" }),
			endId: Type.String({ description: "mNNNNN ref at the end of the range" }),
			summary: Type.String({ description: "Self-contained summary replacing the range" }),
			topic: Type.Optional(Type.String({ description: "Short topic label for the block" })),
		}),
		{ minItems: 1, description: "REQUIRED — compress without content is invalid." },
	),
});

export const decompressParams = Type.Object({
	blockId: Type.String({ description: "Block ID to decompress (e.g. b5)" }),
	full: Type.Optional(Type.Boolean({ description: "Restore all the way to original messages" })),
});

export const searchContextParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
});

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

function formatCompressResult(result: {
	blocksCreated: number;
	tokensCompressed: number;
	errors: string[];
	warnings: string[];
}): string {
	const lines: string[] = [];
	if (result.blocksCreated > 0) {
		lines.push(`[Compressed → ${result.blocksCreated} block(s), ~${result.tokensCompressed} tokens saved.]`);
	} else {
		lines.push("[Nothing compressed.]");
	}
	for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
	for (const error of result.errors) lines.push(error);
	return lines.join("\n");
}

/** compress 工具的宽容参数预处理（字符串 JSON / 单对象 → 标准 content 数组） */
export function prepareCompressArguments(args: unknown): { content: unknown[] } {
	const ranges = parseCompressInput(args);
	if (ranges.length > 0) {
		return {
			content: ranges.map((r) => ({
				startId: r.startRef,
				endId: r.endRef,
				summary: r.summary,
				...(r.topic !== undefined ? { topic: r.topic } : {}),
			})),
		};
	}
	// 解析不出任何 range：原样放行，execute 内做诊断（parseCompressInput 的错误文案面向模型）
	return args as { content: unknown[] };
}

export function makeAcpTools(deps: AcpToolDeps): ToolDefinition[] {
	const compress: ToolDefinition<typeof compressParams> = {
		name: "compress",
		label: "Compress",
		description: COMPRESS_TOOL.description,
		promptSnippet: "compress({ content: [{ startId, endId, summary }] }) — batch multiple ranges per call",
		promptGuidelines: [
			'Each message carries an <acp tokens="2.1K">m00175</acp> tag with its ref. Compress ranges by those refs.',
			"Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
			"Never compress content the current task step is actively using; todo tool outputs are protected and never compressible.",
		],
		parameters: compressParams,
		prepareArguments: (args) => prepareCompressArguments(args) as never,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const parsed = parseCompressInput({ content: params.content }, toolCallId);
			if (parsed.length === 0) {
				throw new Error(
					'Invalid content: must be an ARRAY of {startId, endId, summary} objects. Example: compress({ content: [{ startId: "m00005", endId: "m00080", summary: "..." }] })',
				);
			}
			return deps.withAcpState(ctx, async ({ state, coreMessages, config }) => {
				const result = deps.core.applyCompression({
					ranges: parsed.map((r) => ({
						startRef: r.startRef,
						endRef: r.endRef,
						summary: r.summary,
						...(r.topic !== undefined ? { topic: r.topic } : {}),
						compressCallId: toolCallId,
					})),
					messages: coreMessages,
					state,
					config,
				});
				return {
					state: result.state,
					value: textResult(formatCompressResult(result.result)),
				};
			});
		},
	};

	const decompress: ToolDefinition<typeof decompressParams> = {
		name: "decompress",
		label: "Decompress",
		description:
			"Restores previously compressed content into the tool result. Use when you need exact details lost in compression. full:true restores all the way to original messages.",
		promptSnippet: "decompress({ blockId }) — restore a compressed block's content",
		parameters: decompressParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return deps.withAcpState(ctx, async ({ state, coreMessages }) => {
				const normalized = String((params as { blockId?: unknown }).blockId ?? "")
					.trim()
					.toLowerCase();
				const match = /^b0*(\d+)$/.exec(normalized) ?? /^(\d+)$/.exec(normalized);
				const blockId = match ? `b${match[1]}` : normalized;
				const block = deps.core.decompress(blockId, state);
				if (!block) {
					return { value: textResult(`Block ${blockId} not found. Run acp_status to list current blocks.`) };
				}
				const collected = collectBlockContent(state, block, coreMessages, {
					full: (params as { full?: unknown }).full === true,
				});
				if (collected.count === 0) {
					return { value: textResult(`Block ${blockId} is empty (original messages no longer in context).`) };
				}
				const head = `Block ${blockId}${block.topic ? ` — ${block.topic}` : ""} restored (${collected.count} item(s)):\n\n`;
				return { value: textResult(head + collected.text) };
			});
		},
	};

	const searchContext: ToolDefinition<typeof searchContextParams> = {
		name: "search_context",
		label: "Search context",
		description: SEARCH_CONTEXT_TOOL.description,
		promptSnippet: 'search_context({ query: "auth token refresh" }) — find compressed content',
		parameters: searchContextParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return deps.withAcpState(ctx, async ({ state }) => {
				const query = String((params as { query?: unknown }).query ?? "").trim();
				if (!query) return { value: textResult("Query is required.") };
				const limit = Number((params as { limit?: unknown }).limit) || 5;
				const blocks = deps.core.search(query, state).slice(0, limit);
				if (blocks.length === 0) {
					return { value: textResult(`No compressed blocks match "${query}".`) };
				}
				const lines = blocks.map(
					(b) =>
						`${b.blockId}${b.topic ? ` (${b.topic})` : ""} tier${b.tier} ~${b.compressedTokens} tok: ${b.summary.slice(0, 300)}`,
				);
				return { value: textResult(`Matches:\n${lines.join("\n")}`) };
			});
		},
	};

	const acpStatus: ToolDefinition<ReturnType<typeof Type.Object>> = {
		name: "acp_status",
		label: "ACP status",
		description: ACP_STATUS_TOOL.description,
		promptSnippet: "acp_status() — context usage + compressible ranges",
		parameters: Type.Object({}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return deps.withAcpState(ctx, async ({ state, coreMessages, config }) => {
				void params;
				const report = buildStatusReport(state, coreMessages, defaultCountTokens, {});
				void config;
				return { value: textResult(report) };
			});
		},
	};

	return [compress, decompress, searchContext, acpStatus];
}
