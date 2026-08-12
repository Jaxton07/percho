/**
 * 开屏 DOM 生成：index.html 中排在主 bundle 前的独立 module，首帧前同步建 DOM
 * （样式 splash.css 渲染阻塞先行就绪，动画是纯 CSS keyframes，本文件只一次性建 DOM）。
 * 粒子参数由黄金角螺旋程序化生成 —— 调整数量只需改 DOT_COUNT。
 */

const DOT_COUNT = 64;
const GOLDEN_ANGLE_RAD = 137.508 * (Math.PI / 180);
const SPREAD = 13.2; // 半径 = SPREAD * sqrt(i)，最外圈约 105px

function buildDots(): string {
	let html = "";
	for (let i = 1; i <= DOT_COUNT; i++) {
		const r = SPREAD * Math.sqrt(i);
		const theta = i * GOLDEN_ANGLE_RAD;
		const x = Math.round(r * Math.cos(theta));
		const y = Math.round(r * Math.sin(theta));
		// 中心大且亮、边缘小且淡；尺寸加少量档位抖动避免机械感
		const size = Math.max(3, 13.5 - r * 0.1 + ((i * 7) % 3) - 1);
		const opacity = Math.min(1, Math.max(0.35, 1.02 - r * 0.0065));
		const duration = 3.1 + ((i * 13) % 37) / 10; // 3.1s – 6.7s
		const delay = -((i * 29) % 67) / 10; // 负延迟 = 立即处于各自相位，不同步起跑
		// 收場飞出屏外的目标点：沿各自径向向外 1100px（任何窗口都出屏）
		const ex = Math.round(x * 3 + Math.cos(theta) * 1100);
		const ey = Math.round(y * 3 + Math.sin(theta) * 1100);
		html += `<i class="sp-dot" style="--x:${x}px;--y:${y}px;--ex:${ex}px;--ey:${ey}px;--s:${size.toFixed(1)}px;--o:${opacity.toFixed(2)};--t:${duration.toFixed(1)}s;--dl:${delay.toFixed(1)}s"></i>`;
	}
	return html;
}

const splash = document.createElement("div");
splash.id = "splash";
splash.setAttribute("aria-hidden", "true");
splash.innerHTML = `
	<div class="sp-swarm">
		<div class="sp-swarm-in">
			<div class="sp-swarm-breathe">${buildDots()}</div>
		</div>
	</div>
	<div class="sp-rings"></div>
	<div class="sp-wave"></div>
	<div class="sp-word">pi</div>
	<div class="sp-line"></div>`;
document.body.append(splash);
