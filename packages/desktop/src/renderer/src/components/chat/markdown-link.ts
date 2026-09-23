/** Markdown 链接不能按 app 页面 URL 解析：相对文件路径必须交给会话 cwd。 */
export type MarkdownLink =
	| { kind: "external"; url: string }
	| { kind: "file"; target: string }
	| { kind: "anchor" }
	| { kind: "unsupported" };

export function classifyMarkdownLink(href: string): MarkdownLink {
	const target = href.trim();
	if (!target) return { kind: "unsupported" };
	if (target.startsWith("#")) return { kind: "anchor" };
	if (/^https?:\/\//i.test(target)) return { kind: "external", url: target };
	// 不能把协议相对 URL / 其它协议送进 shell.openPath（更不能在 app 内导航）。
	if (target.startsWith("//") || (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^file:\/\//i.test(target))) {
		return { kind: "unsupported" };
	}
	return { kind: "file", target };
}
