(() => {
	const out = [];
	const seen = new Set();
	const walk = (el, depth) => {
		if (depth > 8 || seen.has(el)) return;
		seen.add(el);
		const sw = el.scrollWidth,
			cw = el.clientWidth,
			ow = el.offsetWidth;
		const cls = (typeof el.className === "string" ? el.className : "").slice(0, 50);
		out.push(`${"  ".repeat(depth)}${el.tagName} ow=${ow} cw=${cw} sw=${sw}${sw > ow ? " <<<" : ""} ${cls}`);
		for (const c of el.children) walk(c, depth + 1);
	};
	const ul = [...document.querySelectorAll("ul")].find((u) => u.className.includes("divide-y"));
	for (const [i, li] of [...ul.children].entries()) {
		if (li.scrollWidth > li.clientWidth + 2) {
			out.push(`>>> suspect li #${i}: sw=${li.scrollWidth} cw=${li.clientWidth}`);
			walk(li, 0);
			break;
		}
	}
	return out.join("\n");
})();
