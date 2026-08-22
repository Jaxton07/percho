import MarkdownRender from "markstream-react";
import "markstream-react/index.css";
// 验证 @percho/shared alias 在 lan-web 独立 vite 构建下可用（运行时值导入，非仅类型）
import { TODO_TOOL_NAME } from "@percho/shared";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const FULL_TEXT = `# 冒烟测试

这是一段 **markdown** 流式渲染验证，含 \`inline code\` 与列表：

- 第一项 alpha
- 第二项 beta

\`\`\`ts
interface SessionView {
	sessionId: string;
	agentActive: boolean;
	stats: { inputTokens: number; outputTokens: number } | null;
}

export function tail(view: SessionView): string {
	return view.stats ? String(view.stats.inputTokens) : "n/a";
}
\`\`\`

> 引用块：sanity check 完成。

| 列 A | 列 B |
|---|---|
| 1 | one |
| 2 | two |

末尾段落，流式结束。
`;

function Smoke() {
	const [text, setText] = useState("");
	const [streaming, setStreaming] = useState(true);
	useEffect(() => {
		let i = 0;
		const timer = setInterval(() => {
			i += 7;
			setText(FULL_TEXT.slice(0, i));
			if (i >= FULL_TEXT.length) {
				clearInterval(timer);
				setStreaming(false);
			}
		}, 60);
		return () => clearInterval(timer);
	}, []);
	return (
		<div style={{ maxWidth: 680, margin: "0 auto", padding: 16, fontFamily: "system-ui" }}>
			<h1 style={{ fontSize: 18 }}>lan-web smoke — markstream + singlefile（{TODO_TOOL_NAME}）</h1>
			<div className="markdown-body">
				<MarkdownRender content={text} final={!streaming} isDark={false} deferNodesUntilVisible={false} />
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");
createRoot(root).render(<Smoke />);
