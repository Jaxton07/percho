/** A range can cross the entire closing view while both endpoints remain outside it. */
export function clearSelectionWithin(element: HTMLElement): void {
	const selection = window.getSelection();
	if (!selection) return;
	for (let index = 0; index < selection.rangeCount; index++) {
		if (selection.getRangeAt(index).intersectsNode(element)) {
			selection.removeAllRanges();
			return;
		}
	}
}
