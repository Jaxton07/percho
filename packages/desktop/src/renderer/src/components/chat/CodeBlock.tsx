/** biome-ignore-all lint/security/noDangerouslySetInnerHtml: shiki 本地生成的高亮 HTML，代码文本已被 shiki 转义 */
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { highlightCode } from "./code-highlight";

/** 代码块：shiki 高亮 + 复制按钮 */
export function CodeBlock({ className, children }: { className?: string; children: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const [html, setHtml] = useState<string | null>(null);
	const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? "text";

	useEffect(() => {
		let cancelled = false;
		void highlightCode(children, lang).then((result) => {
			if (!cancelled) setHtml(result);
		});
		return () => {
			cancelled = true;
		};
	}, [children, lang]);

	return (
		<div className="group relative my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
			<button
				type="button"
				className="absolute right-2 top-2 z-10 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] text-zinc-500 opacity-0 transition-opacity hover:text-zinc-800 group-hover:opacity-100"
				onClick={() => {
					void navigator.clipboard.writeText(children);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? t("message.copied") : t("message.copy")}
			</button>
			{lang !== "text" && (
				<span className="absolute left-3 top-2 text-[10px] text-zinc-400 select-none">{lang}</span>
			)}
			{html ? (
				<div
					className="shiki-body overflow-x-auto p-3 text-[12.5px] leading-relaxed select-text"
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed text-zinc-800 select-text">
					<code>{children}</code>
				</pre>
			)}
		</div>
	);
}
