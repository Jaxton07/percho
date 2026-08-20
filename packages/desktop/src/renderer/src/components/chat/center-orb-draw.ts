/**
 * 中央状态动画的绘制（概念 D · 神经流，playground 定稿见 .local/design/components/center-status-anim/）。
 *
 * 两态合一：原 working（思考）/ connecting（调工具）双态的交叉淡化切换被用户判为「不自然」，
 * 现合并为中速单动画（速度/密度取原两态之间）——无状态切换 = 无硬切，显隐只剩一层淡入淡出。
 *
 * 全部运动是 t 的闭式函数（哈希播种伪随机、无模拟状态）→ 任意帧画面只由 t 决定，重启循环零毛刺。
 * 哑光：亮暗全靠墨色透明度灰阶（浅底近黑 rgba(24,24,27) / 深底柔白 rgba(244,244,245)），无 shadowBlur 光晕。
 *
 * 遮罩一体：帧首画页面底色径向渐变圆盘（与底色同色 → 盘隐形，只压身后文字突出动画）。
 * 画布随 CenterOrb 整体 z-20 盖在文字层之上，故圆盘直接生效；边缘渐隐无硬边，哑光体系不要真模糊。
 */

const TAU = Math.PI * 2;

/** 调参常量（与 playground 面板一一对应；要改先在 playground 里验证再回搬） */
const O = {
	count: 170, // 粒子数
	speed: 1.3, // 流转速度倍率（合一：原思考 1.0 与调工具 1.8 之间）
	trail: 0.22, // 拖尾时长 s
	linkDist: 6, // 突触连接距离（逻辑单位，S=64 空间）
	linkAlpha: 0.2, // 连接线基础强度
	lineW: 0.22, // 连接线宽（发丝线）
	sigRate: 0.15, // 信号脉冲密度（合一：原 0.1 / 0.2 之间）
	sweep: 1.5, // 亮度信号波速（合一：原 1.0 / 2.2 之间）
	flash: 1, // 个体放电频率倍率
	flashWeight: 0.95, // 放电亮度权重（合一：原 0.8 / 1.1 之间）
	breathPeriod: 3.6, // 整体呼吸周期 s（合一：原 4.6 / 2.6 之间）
	dot: 0.6, // 粒子点径
	maskR: 36, // 遮罩圆盘半径（逻辑单位；粒子场 r≈31，渐隐在 r≈28 归零，超出部分画布裁剪不可见）
	maskAlpha: 0.72, // 遮罩中心不透明度（55% 处 0.6 倍、78% 处归零）
} as const;

/** 哑光墨色 */
function ink(dark: boolean, a: number): string {
	return dark ? `rgba(244,244,245,${a})` : `rgba(24,24,27,${a})`;
}

/** 确定性哈希（播种伪随机）：所有运动仅是 t 的闭式函数 */
const NH = (i: number, k: number): number => {
	const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
	return x - Math.floor(x);
};
/** 三元哈希：信号脉冲按「时间槽」决定激活 */
const NH3 = (i: number, j: number, s: number): number => {
	const x = Math.sin(i * 127.1 + j * 269.5 + (s % 2048) * 311.7) * 43758.5453;
	return x - Math.floor(x);
};

/** 每粒子常量：带归属 / 带内均匀相位 / 各谐波哈希 */
interface ParticleConst {
	band: 0 | 1;
	th0: number;
	r0: number;
	h1: number;
	h2: number;
	h3: number;
	h5: number;
	h6: number;
}
let cachedN = 0;
let cachedConsts: ParticleConst[] = [];
function particleConsts(N: number): ParticleConst[] {
	if (cachedN === N && cachedConsts.length > 0) return cachedConsts;
	const counts: [number, number] = [0, 0];
	for (let i = 0; i < N; i++) {
		counts[NH(i, 7) < 0.45 ? 0 : 1]++;
	}
	const seen: [number, number] = [0, 0];
	const arr: ParticleConst[] = [];
	for (let i = 0; i < N; i++) {
		const band: 0 | 1 = NH(i, 7) < 0.45 ? 0 : 1;
		arr.push({
			band,
			// 带内均匀相位 + 小抖动：整体均布不结团，有机感交给时间项
			th0: ((seen[band]++ + 0.5) / counts[band]) * TAU + (NH(i, 4) - 0.5) * 0.5,
			r0: band === 0 ? 2.5 + 10.5 * Math.sqrt(NH(i, 1)) : 14 + 15.5 * Math.sqrt(NH(i, 1)),
			h1: NH(i, 1),
			h2: NH(i, 2),
			h3: NH(i, 3),
			h5: NH(i, 5),
			h6: NH(i, 6),
		});
	}
	cachedConsts = arr;
	cachedN = N;
	return arr;
}

/** 遮罩圆盘渐变：按 (dark, c) 缓存，避免每帧分配 gradient 对象 */
let maskCache: { dark: boolean; c: number; grad: CanvasGradient } | null = null;
function maskGradient(ctx: CanvasRenderingContext2D, c: number, dark: boolean): CanvasGradient {
	if (maskCache && maskCache.dark === dark && maskCache.c === c) return maskCache.grad;
	const grad = ctx.createRadialGradient(c, c, 0, c, c, O.maskR);
	// 遮罩 = 页面底色（日间 #fafafa / 夜间 #17171a）：盘与背景无缝隐形，只压身后文字；
	// 夜间不用更浅的灰（38,38,42 会把区域提亮成可见灰盘，被用户否），也不用纯黑（比底色更黑边缘显圆）
	const m = (a: number) => (dark ? `rgba(23,23,26,${a})` : `rgba(250,250,250,${a})`);
	grad.addColorStop(0, m(O.maskAlpha));
	grad.addColorStop(0.55, m(O.maskAlpha * 0.6));
	grad.addColorStop(0.78, m(0));
	grad.addColorStop(1, m(0));
	maskCache = { dark, c, grad };
	return grad;
}

/** 单粒子当前帧快照 */
interface Pt {
	p: ParticleConst;
	x: number;
	y: number;
	b: number;
}

/**
 * 神经流绘制主函数。ctx 需已做 transform（逻辑空间 S×S），t 单位秒。
 * 结构：粒子分内外两带对转 + 径向呼吸；每带两道对向亮度波绕行 + 个体周期放电；
 * 近邻连突触细线（两端越亮线越亮）；信号脉冲沿连接线从较亮端流向另一端；中心呼吸圆点锚点。
 */
export function drawCenterOrb(ctx: CanvasRenderingContext2D, S: number, t: number, dark: boolean): void {
	const o = O;
	const c = S / 2;
	// 位置（闭式）：窄速差保持队形相干，角向摆动 + 径向呼吸带来有机感
	const posAt = (p: ParticleConst, tt: number): [number, number] => {
		const breath = 1 + 0.035 * Math.sin((TAU * tt) / o.breathPeriod);
		const dir = p.band === 0 ? 1 : -1;
		const w = dir * (0.2 + 0.12 * (p.h2 - 0.5)) * o.speed;
		const th = p.th0 + tt * w + 0.3 * Math.sin(tt * (0.1 + 0.15 * p.h1) + p.h2 * TAU);
		const r = (p.r0 + 2.0 * Math.sin(tt * (0.22 + 0.3 * p.h3) + p.h1 * TAU)) * breath;
		return [r, th];
	};
	const pts: Pt[] = [];
	for (const p of particleConsts(Math.round(o.count))) {
		const [r, th] = posAt(p, t);
		// 亮度 = 每带两道对向角向信号波（高斯包络）+ 个体周期放电（指数衰减）
		const w0 = (p.band === 1 ? -1 : 1) * o.sweep * 0.9;
		const g = (dd: number) => Math.exp(-(dd * dd) / (2 * 0.42 * 0.42));
		const d1 = Math.atan2(Math.sin(th - w0 * t), Math.cos(th - w0 * t));
		const d2 = Math.atan2(Math.sin(th - w0 * t - Math.PI), Math.cos(th - w0 * t - Math.PI));
		let b = g(d1) + 0.6 * g(d2);
		const Pd = (2.5 + 5 * p.h5) / o.flash;
		b += Math.exp(-((t + p.h6 * Pd) % Pd) * 5) * o.flashWeight;
		const ef = r > 26 ? Math.max(0, 1 - (r - 26) / 4.5) : 1; // 边缘渐隐 → 圆润剪影
		pts.push({ p, x: c + r * Math.cos(th), y: c + r * Math.sin(th), b: Math.min(1.4, b) * ef });
	}
	// 遮罩圆盘（一体式，必先于粒子绘制）：压住身后文字、突出动画本体
	ctx.fillStyle = maskGradient(ctx, c, dark);
	ctx.beginPath();
	ctx.arc(c, c, o.maskR, 0, TAU);
	ctx.fill();
	ctx.lineCap = "round";
	// 突触连接 + 信号脉冲
	const slotDur = 1.0 / o.speed; // 脉冲行进时长随流转速度
	for (const [i, pi] of pts.entries()) {
		for (const [j, pj] of pts.entries()) {
			if (j <= i) continue;
			const dx = pi.x - pj.x;
			const dy = pi.y - pj.y;
			const d2 = dx * dx + dy * dy;
			if (d2 > o.linkDist * o.linkDist) continue;
			const d = Math.sqrt(d2);
			const g = 1 - d / o.linkDist;
			const a = g * (o.linkAlpha + 0.5 * Math.min(pi.b, pj.b));
			if (a >= 0.02) {
				ctx.beginPath();
				ctx.moveTo(pi.x, pi.y);
				ctx.lineTo(pj.x, pj.y);
				ctx.strokeStyle = ink(dark, a);
				ctx.lineWidth = o.lineW;
				ctx.stroke();
			}
			// 信号脉冲：哈希抽选（源头越亮越易发放）；相位按线错开，否则全场同步起落集体隐形
			const bSrc = Math.max(pi.b, pj.b);
			const slotF = t / slotDur + NH3(i, j, 999);
			const slotN = Math.floor(slotF);
			if (NH3(i, j, slotN) >= o.sigRate * (0.25 + 1.6 * bSrc)) continue;
			const prog = slotF - slotN;
			const fromI = pi.b >= pj.b;
			const x0 = fromI ? pi.x : pj.x;
			const y0 = fromI ? pi.y : pj.y;
			const x1 = fromI ? pj.x : pi.x;
			const y1 = fromI ? pj.y : pi.y;
			const env = Math.sin(Math.PI * prog) * Math.min(1, g * 2.5); // 端点淡入淡出；线快断时衰减
			const tb = Math.max(0, prog - 0.18); // 短拖尾随来路
			ctx.beginPath();
			ctx.moveTo(x0 + (x1 - x0) * tb, y0 + (y1 - y0) * tb);
			ctx.lineTo(x0 + (x1 - x0) * prog, y0 + (y1 - y0) * prog);
			ctx.strokeStyle = ink(dark, env * 0.45);
			ctx.lineWidth = o.lineW * 1.6;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(x0 + (x1 - x0) * prog, y0 + (y1 - y0) * prog, o.dot * 0.85, 0, TAU);
			ctx.fillStyle = ink(dark, env * 0.95);
			ctx.fill();
		}
	}
	// 拖尾（短线指向运动方向 = 流转感）+ 粒子点（亮度调制半径/透明度）
	for (const pt of pts) {
		const [r0, th0] = posAt(pt.p, t - o.trail);
		ctx.beginPath();
		ctx.moveTo(c + r0 * Math.cos(th0), c + r0 * Math.sin(th0));
		ctx.lineTo(pt.x, pt.y);
		ctx.strokeStyle = ink(dark, 0.35 * Math.min(1, pt.b));
		ctx.lineWidth = 0.45;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(pt.x, pt.y, o.dot * (0.6 + 1.0 * Math.min(1, pt.b)), 0, TAU);
		ctx.fillStyle = ink(dark, Math.min(1, 0.42 + 0.55 * pt.b));
		ctx.fill();
	}
	// 中心锚点：呼吸圆点
	const cr = 1.35 * (1 + 0.16 * Math.sin((TAU * t) / 3.4 + 1.2));
	ctx.beginPath();
	ctx.arc(c, c, cr, 0, TAU);
	ctx.fillStyle = ink(dark, 0.9);
	ctx.fill();
}
