/** Validate topic names in legacy subscription records. */
export function validateTopic(topic: string): string | null {
	if (typeof topic !== "string" || topic.length === 0) return "topic 不能为空";
	if (topic.length > 128) return "topic 过长（≤128 字符）";
	if (topic === "." || topic === "..") return "topic 不能是 . 或 ..";
	if (topic.startsWith(".")) return "topic 不能以 . 开头（隐藏目录）";
	if (topic.includes("/") || topic.includes("\\")) return "topic 不能包含路径分隔符";
	if (topic.includes("\0")) return "topic 含非法字符";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(topic)) {
		return "topic 只能包含字母数字 . _ -（且以字母数字开头）";
	}
	return null;
}
