import { type ComposerDocument, composerPartText } from "@percho/shared";

export function ReferenceText({ document }: { document: ComposerDocument }) {
	return (
		<span className="whitespace-pre-wrap break-words">
			{document.parts.map((part, index) => {
				if (part.type === "text") return part.text;
				const directory = part.type === "file" && part.kind === "directory";
				const className = `composer-reference composer-reference-${part.type}${directory ? " composer-reference-directory" : ""}`;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: immutable ordered message parts
					<span key={index} className={className}>
						{composerPartText(part)}
					</span>
				);
			})}
		</span>
	);
}
