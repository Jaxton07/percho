import {
	MermaidBlockNode,
	type MermaidBlockNodeProps,
	setCustomComponents,
	setDefaultI18nMap,
} from "markstream-react";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { type Language, translate, useI18nStore, useT } from "../../i18n";
import { ChevronRightIcon, CopyIcon, ErrorCircleIcon } from "../icons";

/**
 * mermaid 图表卡（markstream 的 code_block + language=mermaid 节点，走 customComponents 接管）。
 *
 * 为什么要在库组件外面再包一层：
 * 1. 失败态：库的渲染链路是「先 parse 校验、再 render」，parse 失败时它只在内部静默放弃
 *    （catch 里连错误行都不写），界面上只剩一个空白框，没有任何提示。这里用 mermaid.parse
 *    自己复校验一次，失败就换成 Percho 的报错卡（glyph + 标题 + 可展开源码），对齐 error-system。
 * 2. 配置：isStrict=false（见下）、裁掉用不到的工具栏按钮。
 *
 * isStrict 必须为 false：库默认 true → mermaid `flowchart.htmlLabels:false`，节点标签走纯 SVG
 * text 路径，`<br/>` 被吞掉（多行标签挤成一行并溢出框）。loose 模式保留 htmlLabels，库插入前
 * 又会经 stream-markdown-parser 的 scrubSvgElement 把 foreignObject 拆成 <text>+<tspan>（换行保留、
 * HTML 标签被拍平），因此不引入额外注入面。
 */
const MERMAID_PROPS = {
	isStrict: false,
	showHeader: true, // header 里放着按钮，关掉会连复制一起没了（样式上悬浮化，见 globals.css）
	showModeToggle: true, // 预览 / 源码
	showCopyButton: true,
	showFullscreenButton: true,
	showCollapseButton: false,
	showExportButton: false,
	showZoomControls: false,
	enableWheelZoom: false,
} as const;

/** 源码稳定多久后校验：库自己 contentStableDelayMs 500 / renderDebounceMs 300，取同量级防抖 */
const VALIDATE_DELAY_MS = 400;

interface MermaidModule {
	parse?: (code: string) => Promise<unknown> | unknown;
}

/**
 * 与 markstream 渲染前的归一化保持一致（`]::x` → `]:::x`、`:::subgraphNode` → `::subgraphNode`）。
 * 不复刻的话，mermaid 实际能渲染的图会被我们误判成失败。
 */
function normalizeMermaidSource(code: string): string {
	return code.replace(/\]::([^:])/g, "]:::$1").replace(/:::subgraphNode$/gm, "::subgraphNode");
}

function firstLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String((error as { message?: unknown })?.message ?? error);
}

/** 校验源码能否被 mermaid 解析；返回失败原因（null = 通过或无法判定） */
async function validate(code: string): Promise<string | null> {
	try {
		const mod = (await import("mermaid")) as { default?: MermaidModule } & MermaidModule;
		const api = mod.default ?? mod;
		// 库不可用（LAN 版把 mermaid alias 成空模块）时不做判定，交给 markstream 自己降级成源码卡
		if (typeof api?.parse !== "function") return null;
		await api.parse(normalizeMermaidSource(code));
		return null;
	} catch (error) {
		return firstLine(errorText(error));
	}
}

/** markstream 内置 UI 文案（预览/源码/复制/关闭…）走它自己的全局字典，用 Percho 的 i18n 覆盖 */
function syncMarkstreamI18n(language: Language): void {
	const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
	setDefaultI18nMap({
		"common.copy": t("mermaid.copy"),
		"common.copied": t("mermaid.copied"),
		"common.preview": t("mermaid.preview"),
		"common.source": t("mermaid.source"),
		"common.export": t("mermaid.export"),
		"common.open": t("mermaid.open"),
		"common.close": t("mermaid.close"),
		"common.expand": t("mermaid.expand"),
		"common.collapse": t("mermaid.collapse"),
		"common.zoomIn": t("mermaid.zoomIn"),
		"common.zoomOut": t("mermaid.zoomOut"),
		"common.resetZoom": t("mermaid.resetZoom"),
		"common.increase": t("mermaid.increase"),
		"common.decrease": t("mermaid.decrease"),
		"common.reset": t("mermaid.reset"),
		"image.loading": t("mermaid.imageLoading"),
		"image.loadError": t("mermaid.imageLoadError"),
	});
}

export function MermaidBlock(props: MermaidBlockNodeProps) {
	const t = useT();
	const code = props.node.code ?? "";
	const streaming = Boolean(props.node.loading);
	const [failure, setFailure] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	// 源码更新（流式续写、重新生成）先清掉旧失败态，避免旧错误停在界面上
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在源码变化时重置
	useEffect(() => {
		setFailure(null);
		setCopied(false);
	}, [code]);

	// 库内部 render 阶段抛错（parse 已通过）也归到同一个失败态
	const handleRenderError = useCallback((error: unknown) => {
		setFailure(firstLine(errorText(error)));
		return true; // 已接管，库不再渲染它自己的错误行
	}, []);

	useEffect(() => {
		if (streaming || !code.trim()) return;
		let cancelled = false;
		const timer = window.setTimeout(async () => {
			const reason = await validate(code);
			if (!cancelled && reason) setFailure(reason);
		}, VALIDATE_DELAY_MS);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [code, streaming]);

	const copySource = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1800);
		} catch {
			// 剪贴板不可用（权限/非安全上下文）：静默
		}
	};

	return (
		<div
			className="md-mermaid"
			data-failed={failure ? "1" : undefined}
			// 库里「Rendering diagram…」是硬编码英文，用 CSS 变量把我们的文案传给 ::after（见 globals.css）
			style={{ "--md-mermaid-rendering": `"${t("mermaid.rendering")}"` } as CSSProperties}
		>
			<MermaidBlockNode {...props} {...MERMAID_PROPS} onRenderError={handleRenderError} />
			{failure && (
				<details className="error-note drawer-details md-mermaid-fail">
					<summary>
						<span className="error-note-sev text-err">
							<ErrorCircleIcon size={14} />
						</span>
						<span className="error-note-title truncate">{t("mermaid.renderFailed")}</span>
						<span className="error-note-meta">{failure}</span>
						<span className="error-note-chev">
							<ChevronRightIcon size={13} />
						</span>
					</summary>
					<div className="error-note-body">
						<pre className="error-note-detail md-mermaid-fail-code">{code}</pre>
						<div className="error-note-actions">
							<button type="button" className="error-note-act" onClick={copySource}>
								<CopyIcon size={12} />
								{t("mermaid.copy")}
							</button>
							<span className={`error-note-copied${copied ? " on" : ""}`}>{t("mermaid.copied")}</span>
						</div>
					</div>
				</details>
			)}
		</div>
	);
}

/**
 * 注册为 mermaid 节点组件：markstream 的 code_block 分发按「语言名」在自定义组件注册表里查
 * （`customComponents[language]`），而该注册表只有全局入口 setCustomComponents——NodeRendererProps
 * 上没有这个 prop，也不读 streamingComponents。注册会 bump revision，已挂载的渲染器随即重渲成我们的组件。
 */
setCustomComponents({ mermaid: MermaidBlock });

// markstream 的文案字典是模块级全局，语言一变就同步一次（不在组件里做，避免每个图表卡各注册一遍）
syncMarkstreamI18n(useI18nStore.getState().language);
useI18nStore.subscribe((state, prev) => {
	if (state.language !== prev.language) syncMarkstreamI18n(state.language);
});
