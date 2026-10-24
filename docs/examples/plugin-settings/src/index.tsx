/**
 * 插件设置示例（perchoUi 2）
 *
 * 位置说明：本示例刻意留在 docs/examples/ 而不是 resources/ui-plugins/examples/——后者会被 seeder 拷进
 * 每个用户的 <userData>/ui-plugins/_examples/，等于替用户预装。不改动原版 Percho 的默认状态，想用自己复制。
 *
 * 两个能力各演示一半：
 * 1. settingsSchema（plugin.json 里）：宿主自动生成设置页，**这个文件里没有任何设置 UI 代码**；
 * 2. isolation: "shadow"：这个角标挂在 shadow root 里，用宿主主题表的语义类（.p*）+ 自带
 *    src/style.css，样式既不污染宿主、也拿不到宿主的 Tailwind 工具类。
 */

import { usePluginSettings } from "@percho/plugin-api";
import { useEffect, useState } from "react";

interface DemoSettings {
	showBadge: boolean;
	prefix: string;
	refreshSeconds: number;
	tone: "plain" | "accent";
}

export function SettingsBadge() {
	// 与设置页读写同一份配置：改设置 → 角标立即跟着变
	const { values } = usePluginSettings<DemoSettings>("plugin-settings", {
		showBadge: true,
		prefix: "bw",
		refreshSeconds: 15,
		tone: "plain",
	});
	// 演示一个真实副作用：按配置的间隔自增计数（避免示例只画静态文字）
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const seconds = Math.max(5, Number(values.refreshSeconds) || 15);
		const timer = window.setInterval(() => setTick((n) => n + 1), seconds * 1000);
		return () => window.clearInterval(timer);
	}, [values.refreshSeconds]);

	if (!values.showBadge) return null;
	return (
		<div className={`pbadge pinteractive ${values.tone === "accent" ? "pbadge-accent" : ""}`}>
			<span className="pbadge-dot" />
			<span className="pbadge-text">
				{values.prefix || "bw"} · {tick}
			</span>
		</div>
	);
}
