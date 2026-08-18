import { useLanguage, useSessionsStore, useTranscriptStore } from "@percho/plugin-api";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import blinkUrl from "./assets/blink.png";
import happyUrl from "./assets/happy.png";
import idleUrl from "./assets/idle.png";
import squashUrl from "./assets/squash.png";
import working01Url from "./assets/working01.png";
import working02Url from "./assets/working02.png";

/**
 * Q 版 DeepSeek 鲸鱼娘女仆桌宠（ds-whale-maid 的 Q 版变体）：
 * - 六帧立绘 opacity 交叉切换（idle/blink/squash/happy 站姿；working01/working02 抱电脑敲字姿势）
 * - 工作态双帧循环：working01 常驻作底、working02 以「无过渡瞬时切换」叠在其上，600ms 交替 → 敲字感
 * - 分层嵌套：拖拽 translate（state，最外层）→ 浮动循环（CSS）→ 开心弹跳（CSS 单次）→ 果冻 scale（state）
 *   每层 transform 各管各的，永不互抢
 * - 拖拽：pointer capture + 视口内 clamp；松手果冻回弹；位移 <5px 视为点击 → happy
 * - 工作联动：useTranscriptStore 的 agentActive → 敲字循环 + 头顶吐泡泡
 * - reduced-motion：循环动画全关、泡泡隐藏、眨眼/敲字循环不启动（工作态静态 working01）
 */

/** 显示尺寸（Q 版头大身小，比正比版的 183×364 略小一档）；帧原图 838×1412（1024×1536 裁掉透明边），2x 余量充足 */
const PET_W = 178;
const PET_H = 300;

type Frame = "idle" | "blink" | "working01" | "working02" | "squash" | "happy";
const FRAME_URLS: Record<Frame, string> = {
	idle: idleUrl,
	blink: blinkUrl,
	working01: working01Url,
	working02: working02Url,
	squash: squashUrl,
	happy: happyUrl,
};
const FRAME_ORDER: Frame[] = ["idle", "blink", "working01", "working02", "squash", "happy"];

const WORKING_FRAMES: Frame[] = ["working01", "working02"];

/**
 * 帧可见性：idle 是常驻底层（恒 1），blink/squash 与 idle **同姿势**，在其上淡入淡出即可——
 * 若两帧同时交叉淡化（一个出一个进），中点各 50% 透明、合成 alpha 只有 0.75，背景透光 → 白闪。
 * 例外一 happy（举手姿势不同）：idle 让位交叉淡化，瞬间被弹跳动画掩护。
 * 例外二 working01/02（抱电脑姿势不同）：idle 让位；working01 作工作态底层恒 1，
 * working02 叠在其上瞬时切换（同姿势敲字循环，无白闪问题）。
 */
function frameOpacity(f: Frame, active: Frame): number {
	if (f === "idle") return WORKING_FRAMES.includes(active) || active === "happy" ? 0 : 1;
	if (f === "working01") return WORKING_FRAMES.includes(active) ? 1 : 0;
	return active === f ? 1 : 0;
}

const petCss = `
@keyframes dsmq-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
.dsmq-float { animation: dsmq-float 3.8s ease-in-out infinite; will-change: transform; }

@keyframes dsmq-bounce {
	0% { transform: scale(1); }
	35% { transform: scale(1.1); }
	60% { transform: scale(0.96); }
	100% { transform: scale(1); }
}
.dsmq-bounce { animation: dsmq-bounce 0.62s cubic-bezier(0.34, 1.56, 0.64, 1) 1; transform-origin: 50% 100%; }

.dsmq-stage { position: relative; touch-action: none; outline: none; }
.dsmq-stage:focus-visible { filter: drop-shadow(0 0 6px rgba(125, 175, 255, 0.8)); border-radius: 24px; }
.dsmq-frame {
	position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
	transition: opacity 160ms ease; pointer-events: none; -webkit-user-drag: none;
}
.dsmq-frame-instant { transition: none; }

.dsmq-bubbles { position: absolute; left: 64%; top: 0%; pointer-events: none; }
.dsmq-bubbles i {
	position: absolute; width: 9px; height: 9px; border-radius: 9999px;
	border: 1.5px solid rgba(125, 175, 255, 0.95); background: rgba(190, 220, 255, 0.35);
	opacity: 0; animation: dsmq-bubble 1.8s ease-in infinite;
}
.dsmq-bubbles i:nth-child(2) { left: 14px; width: 6px; height: 6px; animation-delay: 0.6s; }
.dsmq-bubbles i:nth-child(3) { left: -12px; width: 7px; height: 7px; animation-delay: 1.1s; }
@keyframes dsmq-bubble {
	0% { transform: translateY(8px) scale(0.6); opacity: 0; }
	25% { opacity: 0.95; }
	100% { transform: translateY(-36px) scale(1); opacity: 0; }
}

.dsmq-heart {
	position: absolute; left: 50%; top: 29%; font-size: 22px; line-height: 1;
	pointer-events: none; animation: dsmq-heart 0.9s ease-out 1 forwards;
}
@keyframes dsmq-heart {
	0% { opacity: 0; transform: translate(-50%, 8px) scale(0.5); }
	25% { opacity: 1; }
	100% { opacity: 0; transform: translate(-50%, -32px) scale(1.15); }
}

@media (prefers-reduced-motion: reduce) {
	.dsmq-float, .dsmq-bounce, .dsmq-heart { animation: none; }
	.dsmq-bubbles { display: none; }
	.dsmq-frame { transition: none; }
}`;

interface DragState {
	pointerId: number;
	startX: number;
	startY: number;
	baseX: number;
	baseY: number;
	moved: boolean;
	lastX: number;
}

export const Pet = memo(function Pet() {
	const lang = useLanguage();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// agentActive 是 per-session 状态；无活跃会话按空闲处理
	const agentActive = useTranscriptStore((s) =>
		activeSessionId ? (s.bySession[activeSessionId]?.agentActive ?? false) : false,
	);

	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false); // 已越过位移阈值
	const [happyTick, setHappyTick] = useState(0); // 0 = 非开心；>0 每次点击 +1（key 重挂载重启弹跳/爱心动画）
	const [blinking, setBlinking] = useState(false);
	const [workFlip, setWorkFlip] = useState(false); // 工作态双帧交替开关
	const [jelly, setJelly] = useState({ sx: 1, sy: 1 });

	const stageRef = useRef<HTMLButtonElement | null>(null);
	const dragRef = useRef<DragState | null>(null);
	const offsetRef = useRef(offset);
	offsetRef.current = offset;
	const happyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** 以 stage 当前 rect 反推「无偏移基准位」，把目标 offset clamp 进视口（留 10px 边距）；只用 refs/window，useCallback 稳定引用 */
	const clampOffset = useCallback((nx: number, ny: number) => {
		const el = stageRef.current;
		if (!el) return { x: nx, y: ny };
		const cur = offsetRef.current;
		const r = el.getBoundingClientRect();
		const baseL = r.left - cur.x;
		const baseR = r.right - cur.x;
		const baseT = r.top - cur.y;
		const baseB = r.bottom - cur.y;
		const M = 10;
		return {
			x: Math.min(Math.max(nx, M - baseL), window.innerWidth - M - baseR),
			y: Math.min(Math.max(ny, M - baseT), window.innerHeight - M - baseB),
		};
	}, []);

	// 眨眼循环：仅在「纯 idle」时跑（working/拖拽/开心都不眨），随机 2.4s~5.2s 间隔，闭 150ms
	useEffect(() => {
		if (agentActive || dragging || happyTick > 0) return;
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		let t1: ReturnType<typeof setTimeout> | undefined;
		let t2: ReturnType<typeof setTimeout> | undefined;
		let dead = false;
		const loop = () => {
			t1 = setTimeout(
				() => {
					if (dead) return;
					setBlinking(true);
					t2 = setTimeout(() => {
						setBlinking(false);
						if (!dead) loop();
					}, 150);
				},
				2400 + Math.random() * 2800,
			);
		};
		loop();
		return () => {
			dead = true;
			if (t1) clearTimeout(t1);
			if (t2) clearTimeout(t2);
		};
	}, [agentActive, dragging, happyTick]);

	// 敲字循环：工作态且不在拖拽/开心时，600ms 交替 working01/working02；reduced-motion 静态 working01
	useEffect(() => {
		if (!agentActive || dragging || happyTick > 0) {
			setWorkFlip(false);
			return;
		}
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		const t = setInterval(() => setWorkFlip((f) => !f), 600);
		return () => clearInterval(t);
	}, [agentActive, dragging, happyTick]);

	// 窗口缩放时重新 clamp，防宠物被甩出视口
	useEffect(() => {
		const onResize = () => setOffset((o) => clampOffset(o.x, o.y));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [clampOffset]);

	// 开心定时器卸载清理
	useEffect(
		() => () => {
			if (happyTimer.current) clearTimeout(happyTimer.current);
		},
		[],
	);

	const triggerHappy = () => {
		if (happyTimer.current) clearTimeout(happyTimer.current);
		setHappyTick((n) => n + 1);
		happyTimer.current = setTimeout(() => setHappyTick(0), 900);
	};

	const frame: Frame =
		dragging && dragRef.current?.moved
			? "squash"
			: happyTick > 0
				? "happy"
				: agentActive
					? workFlip
						? "working02"
						: "working01"
					: blinking
						? "blink"
						: "idle";

	return (
		<>
			<style>{petCss}</style>
			{/* 拖拽位移层（state）；宿主 overlay 容器是 pointer-events-none，这里自己开回 auto */}
			<div
				className="pointer-events-auto m-5 select-none"
				style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
			>
				{/* 浮动循环层（CSS） */}
				<div className="dsmq-float">
					{/* 开心弹跳层（CSS 单次，key 重挂载重启动画） */}
					<div key={happyTick} className={happyTick > 0 ? "dsmq-bounce" : undefined}>
						{/* 果冻/交互层（state scale + pointer 事件）；原生 button 拿键盘/读屏语义，宿主 Tailwind preflight 已重置默认样式 */}
						<button
							ref={stageRef}
							type="button"
							className="dsmq-stage block"
							aria-label={
								lang === "zh"
									? "Q版鲸鱼娘桌宠：拖拽移动位置，点一下她会开心"
									: "Chibi whale maid pet: drag to move, click to make her happy"
							}
							style={{
								width: PET_W,
								height: PET_H,
								transform: `scale(${jelly.sx}, ${jelly.sy})`,
								transformOrigin: "50% 100%",
								transition: dragging ? "none" : "transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)",
								cursor: dragging ? "grabbing" : "grab",
							}}
							onPointerDown={(e) => {
								if (e.button !== 0) return;
								e.currentTarget.setPointerCapture(e.pointerId);
								dragRef.current = {
									pointerId: e.pointerId,
									startX: e.clientX,
									startY: e.clientY,
									baseX: offsetRef.current.x,
									baseY: offsetRef.current.y,
									moved: false,
									lastX: e.clientX,
								};
							}}
							onPointerMove={(e) => {
								const d = dragRef.current;
								if (!d || e.pointerId !== d.pointerId) return;
								const dx = e.clientX - d.startX;
								const dy = e.clientY - d.startY;
								if (!d.moved) {
									if (Math.hypot(dx, dy) <= 5) return;
									d.moved = true;
									setDragging(true);
								}
								setOffset(clampOffset(d.baseX + dx, d.baseY + dy));
								// 果冻：按横向速度拉伸，松手后 CSS transition 回弹
								const vx = e.clientX - d.lastX;
								d.lastX = e.clientX;
								const k = Math.min(Math.abs(vx) * 0.004, 0.07);
								setJelly({ sx: 1 + k, sy: 1 - k * 0.7 });
							}}
							onPointerUp={(e) => {
								const d = dragRef.current;
								if (!d || e.pointerId !== d.pointerId) return;
								dragRef.current = null;
								setJelly({ sx: 1, sy: 1 });
								if (d.moved) setDragging(false);
								else triggerHappy();
							}}
							onPointerCancel={(e) => {
								const d = dragRef.current;
								if (!d || e.pointerId !== d.pointerId) return;
								dragRef.current = null;
								setDragging(false);
								setJelly({ sx: 1, sy: 1 });
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									triggerHappy();
								}
							}}
						>
							{FRAME_ORDER.map((f) => (
								<img
									key={f}
									src={FRAME_URLS[f]}
									alt=""
									draggable={false}
									className={f === "working02" ? "dsmq-frame dsmq-frame-instant" : "dsmq-frame"}
									style={{ opacity: frameOpacity(f, frame) }}
								/>
							))}
							{agentActive && !dragging && (
								<span className="dsmq-bubbles" aria-hidden="true">
									<i />
									<i />
									<i />
								</span>
							)}
							{happyTick > 0 && (
								<span key={happyTick} className="dsmq-heart" aria-hidden="true">
									💙
								</span>
							)}
						</button>
					</div>
				</div>
			</div>
		</>
	);
});
