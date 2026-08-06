import ReactMarkdown from "react-markdown";
import { CodeBlock } from "./CodeBlock";

/** Markdown 渲染：统一样式映射（链接/标题/表格等），改样式只动这一处 */
export function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown-body text-[14px] leading-relaxed text-zinc-800 select-text">
			<ReactMarkdown
				components={{
					pre: ({ children: preChildren }) => {
						const code = preChildren as React.ReactElement<{
							className?: string;
							children?: string;
						}>;
						const raw = code?.props?.children;
						const str = typeof raw === "string" ? raw : "";
						return <CodeBlock className={code?.props?.className}>{str}</CodeBlock>;
					},
					a: ({ href, children: linkChildren }) => (
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							className="text-violet-600 underline decoration-violet-300 hover:text-violet-700"
						>
							{linkChildren}
						</a>
					),
					p: ({ children: pChildren }) => <p className="my-1.5">{pChildren}</p>,
					ul: ({ children: ulChildren }) => <ul className="my-1.5 list-disc pl-5">{ulChildren}</ul>,
					ol: ({ children: olChildren }) => <ol className="my-1.5 list-decimal pl-5">{olChildren}</ol>,
					li: ({ children: liChildren }) => <li className="my-0.5">{liChildren}</li>,
					code: ({ children: codeChildren }) => (
						<code className="rounded bg-zinc-100 px-1 py-0.5 text-[12.5px] text-zinc-700">
							{codeChildren}
						</code>
					),
					blockquote: ({ children: quoteChildren }) => (
						<blockquote className="my-1.5 border-l-2 border-zinc-200 pl-3 text-zinc-500">
							{quoteChildren}
						</blockquote>
					),
					h1: ({ children: h1Children }) => <h1 className="mb-1 mt-3 text-lg font-semibold">{h1Children}</h1>,
					h2: ({ children: h2Children }) => (
						<h2 className="mb-1 mt-3 text-base font-semibold">{h2Children}</h2>
					),
					h3: ({ children: h3Children }) => <h3 className="mb-1 mt-2 text-sm font-semibold">{h3Children}</h3>,
					table: ({ children: tableChildren }) => (
						<div className="my-2 overflow-x-auto">
							<table className="w-full border-collapse text-[13px]">{tableChildren}</table>
						</div>
					),
					th: ({ children: thChildren }) => (
						<th className="border border-zinc-200 bg-zinc-50 px-2 py-1 text-left">{thChildren}</th>
					),
					td: ({ children: tdChildren }) => (
						<td className="border border-zinc-200 px-2 py-1">{tdChildren}</td>
					),
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
