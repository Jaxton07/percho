let active: Record<string, number> | null = null;
export function beginRendererSwitchProbe(): void {
	active = {};
}
export function measureRendererSwitch(stage: "historyRoundTrip" | "historyInstall"): () => void {
	const target = active;
	if (!target) return () => {};
	const start = performance.now();
	return () => {
		if (active === target) target[stage] = performance.now() - start;
	};
}
export function finishRendererSwitchProbe(): Record<string, number> {
	const result = active ?? {};
	active = null;
	return result;
}
