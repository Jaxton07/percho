import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { UIMessage, UIToolCall } from "../stores/transcript";
import { ToolCallCard } from "./ToolCallCard";

function CodeBlock({ children }: { children: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="group relative my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
			<button
				type="button"
				className="absolute right-2 top-2 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] text-zinc-500 opacity-0 transition-opacity hover:text-zinc-800 group-hover:opacity-100"
				onClick={() => {
					void navigator.clipboard.writeText(children);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? "已复制" : "复制"}
			</button>
			<pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed text-zinc-800 select-text">
				<code>{children}</code>
			</pre>
		</div>
	);
}

function AssistantBody({
	text,
	thinking,
	tools,
	streaming,
}: {
	text: string;
	thinking: string;
	tools: UIToolCall[];
	streaming?: boolean;
}) {
	return (
		<div className="flex flex-col gap-2">
			{thinking && (
				<details className="group rounded-lg border border-zinc-100 bg-zinc-50/80">
					<summary className="cursor-pointer px-2.5 py-1 text-xs text-zinc-400 select-none hover:text-zinc-600">
						思考过程{streaming && "…"}
					</summary>
					<div className="border-t border-zinc-100 px-2.5 py-2 text-[12.5px] leading-relaxed text-zinc-500 whitespace-pre-wrap select-text">
						{thinking}
					</div>
				</details>
			)}
			{tools.length > 0 && (
				<div className="flex flex-col gap-1.5">
					{tools.map((tool, i) => (
						<ToolCallCard key={`${tool.id || i}`} tool={tool} />
					))}
				</div>
			)}
			{text && (
				<div className="markdown-body text-[14px] leading-relaxed text-zinc-800 select-text">
					<ReactMarkdown
						components={{
							pre: ({ children: preChildren }) => {
								const code = preChildren as React.ReactElement<{ children?: string }>;
								const raw = code?.props?.children;
								const str = typeof raw === "string" ? raw : "";
								return <CodeBlock>{str}</CodeBlock>;
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
							h1: ({ children: h1Children }) => (
								<h1 className="mb-1 mt-3 text-lg font-semibold">{h1Children}</h1>
							),
							h2: ({ children: h2Children }) => (
								<h2 className="mb-1 mt-3 text-base font-semibold">{h2Children}</h2>
							),
							h3: ({ children: h3Children }) => (
								<h3 className="mb-1 mt-2 text-sm font-semibold">{h3Children}</h3>
							),
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
			)}
			{streaming && !text && !thinking && tools.length === 0 && (
				<div className="flex items-center gap-1 text-zinc-400">
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:150ms]" />
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:300ms]" />
				</div>
			)}
		</div>
	);
}

export const MessageItem = memo(function MessageItem({
	message,
	streaming,
}: {
	message: UIMessage;
	streaming?: boolean;
}) {
	if (message.kind === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-900 px-3.5 py-2 text-[14px] leading-relaxed text-white select-text">
					{message.text}
				</div>
			</div>
		);
	}

	if (message.kind === "error") {
		return (
			<div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600 select-text">
				{message.text}
			</div>
		);
	}

	return (
		<AssistantBody
			text={message.text}
			thinking={message.thinking}
			tools={message.tools}
			streaming={streaming}
		/>
	);
});
