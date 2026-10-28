/** Bake the existing CSS radial gradients once, rather than rasterizing them at animation scales. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";

const { PNG } = pngjs;
const destination = resolve(import.meta.dirname, "../packages/desktop/src/renderer/src/assets/splash");
const clamp = (value) => Math.max(0, Math.min(1, value));

function texture(size, color, alphaAt) {
	const image = new PNG({ width: size, height: size });
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			// Four samples per pixel keep the soft circular edge stable on Retina screens.
			let alpha = 0;
			for (const dy of [0.25, 0.75])
				for (const dx of [0.25, 0.75]) {
					const radius = Math.hypot(x + dx - size / 2, y + dy - size / 2) / (size / 2);
					alpha += alphaAt(radius) / 4;
				}
			const offset = (y * size + x) * 4;
			image.data[offset] = color[0];
			image.data[offset + 1] = color[1];
			image.data[offset + 2] = color[2];
			image.data[offset + 3] = Math.round(clamp(alpha) * 255);
		}
	}
	return PNG.sync.write(image);
}

function ring(radius, start, peak, opacity) {
	return opacity * clamp(radius < peak ? (radius - start) / (peak - start) : (1 - radius) / (1 - peak));
}

await mkdir(destination, { recursive: true });
for (const [theme, ink, sonar, waveOpacity] of [
	["light", [24, 24, 27], [255, 255, 255], 0.4],
	["dark", [244, 244, 245], [24, 24, 27], 0.55],
]) {
	const images = {
		// CSS circle defaults to farthest-corner; normalize to that radius before applying the stops.
		dot: texture(64, ink, (radius) => (radius > 1 ? 0 : clamp((0.72 - radius / Math.SQRT2) / (0.72 - 0.28)))),
		ring: texture(512, sonar, (radius) => ring(radius, 0.97, 0.986, 0.6)),
		wave: texture(1024, ink, (radius) => ring(radius, 0.965, 0.984, waveOpacity)),
	};
	for (const [name, bytes] of Object.entries(images)) {
		await writeFile(resolve(destination, `${name}-${theme}.png`), bytes);
		console.log(`${name}-${theme}.png: ${bytes.length} bytes`);
	}
}
