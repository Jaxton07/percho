/** A successfully expanded SDK `/skill:` command, parsed from its persisted canonical text. */
export interface SkillInvocation {
	name: string;
	/** SDK skill file path. Kept for parsing/tests only; never render it. */
	location: string;
	args?: string;
}

/** The safe subset used for UI presentation and command restoration. */
export type SkillInvocationDisplay = Pick<SkillInvocation, "name" | "args">;

/**
 * Parses only the SDK 0.84 `_expandSkillCommand()` producer format. The references line
 * deliberately distinguishes real expanded skills from the SDK helper's broader XML grammar.
 */
export function parseExpandedSkillInvocation(text: string): SkillInvocation | null {
	const match = text.match(
		/^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	if (!match) return null;
	const [, name, location, rawArgs] = match;
	if (!name || !location) return null;
	return {
		name,
		location,
		args: rawArgs?.trim() || undefined,
	};
}

/** Rebuilds the reusable command without exposing the expanded body or source path. */
export function formatSkillCommand({ name, args }: SkillInvocationDisplay): string {
	return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}
