let restored = false;
export function hasMixedWorkspaceState(): boolean {
	return restored;
}
export function markMixedWorkspaceState(): void {
	restored = true;
}
