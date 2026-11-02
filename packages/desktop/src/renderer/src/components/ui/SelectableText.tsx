import { memo, useLayoutEffect, useRef } from "react";

/** Plain streaming text: patch characters instead of replacing the node value (which clears native ranges). */
export const SelectableText = memo(function SelectableText({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const initial = useRef(text);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const child = element.firstChild;
		if (!(child instanceof Text)) {
			element.replaceChildren(document.createTextNode(text));
			return;
		}
		const previous = child.data;
		if (previous === text) return;
		if (text.startsWith(previous)) {
			child.appendData(text.slice(previous.length));
			return;
		}
		let prefix = 0,
			suffix = 0;
		while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix++;
		while (
			suffix < previous.length - prefix &&
			suffix < text.length - prefix &&
			previous[previous.length - 1 - suffix] === text[text.length - 1 - suffix]
		)
			suffix++;
		child.replaceData(prefix, previous.length - prefix - suffix, text.slice(prefix, text.length - suffix));
	}, [text]);
	// React owns the span and its initial text; later character edits stay in this leaf.
	return <span ref={ref}>{initial.current}</span>;
});
