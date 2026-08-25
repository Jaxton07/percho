// 复现 185：遍历设置页所有 provider 行，展开模型列表 + 点开关，收集 console/异常
(async () => {
	const out = [];
	const ul = [...document.querySelectorAll("ul")].find((u) => u.className.includes("divide-y"));
	if (!ul) return "no provider ul";
	const lis = [...ul.children];
	out.push(`provider rows: ${lis.length}`);
	for (let i = 0; i < lis.length; i++) {
		const li = lis[i];
		const countBtn = [...li.querySelectorAll("button")].find((b) => /模型|models/i.test(b.textContent));
		if (countBtn) {
			countBtn.click();
			await new Promise((r) => setTimeout(r, 120));
			const switches = [...li.querySelectorAll('[role="switch"]')];
			if (switches.length > 1) {
				switches[1].click();
				await new Promise((r) => setTimeout(r, 60));
				switches[1].click();
				await new Promise((r) => setTimeout(r, 60));
			}
			countBtn.click();
			await new Promise((r) => setTimeout(r, 80));
		}
	}
	return out.join("\n");
})();
