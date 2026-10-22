import { type ComposerDocument, composerPartText } from "@percho/shared";

export function ReferenceText({ document }: { document: ComposerDocument }) {
	return (
		<span className="whitespace-pre-wrap break-words">
			{document.parts.map((part, index) =>
				part.type === "text" ? (
					part.text
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: immutable ordered message parts
					<span key={index} className={`composer-reference composer-reference-${part.type}`}>
						{composerPartText(part)}
					</span>
				),
			)}
		</span>
	);
}
