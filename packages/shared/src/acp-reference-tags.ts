/**
 * Removes complete ACP reference tags only from their own line in display projections.
 * Unknown XML-like text deliberately remains visible.
 */
const ACP_REFERENCE_TAG_LINE =
	/^[\t ]*<acp tokens="[^"\r\n]+" type="[^"\r\n]+">m\d{1,5}<\/acp>[\t ]*(?:\r?\n|$)/gm;

export function stripAcpReferenceTags(text: string): string {
	let removed = false;
	const displayText = text.replace(ACP_REFERENCE_TAG_LINE, () => {
		removed = true;
		return "";
	});
	return removed && displayText.trim().length === 0 ? "" : displayText;
}
