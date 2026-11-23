export const MAX_PARTICLES = 540;
export const PARTICLE_SPACING = 1.5;
export const SWEEP_SPEED = 540;
export const MIN_SWEEP_DURATION = 1067;

const groups = Array.from({ length: 9 }, (_, id) => {
	let seed = 38197 + id * 917;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	return Array.from({ length: MAX_PARTICLES / 9 }, () => {
		const x = (id + random()) / 9;
		const y = 12 + (random() + random() - 1) * 8.7;
		const edge = Math.max(0.08, Math.min(1, x / 0.03, (1 - x) / 0.04));
		return {
			x: `${x * 100}%`,
			y,
			opacity: (0.35 + random() * 0.65) * edge,
			r: 0.35 + random() ** 1.8 * 0.75,
		};
	});
});

export const PARTICLES = groups;
export const ENVELOPE = Array.from({ length: 33 }, (_, i) => ({
	offset: i / 32,
	alpha: Math.sin((Math.PI * i) / 32) ** 2,
}));
export const BAND = 160;
