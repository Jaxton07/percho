/** Transport-level checks. Complex domain DTOs still pass through their existing backend validation. */
export interface InputRule<T> {
	readonly value?: T;
	readonly optional?: true;
	validate(value: unknown): void;
}
export type ArgumentRules<A> = {
	[K in keyof A]-?: undefined extends A[K]
		? InputRule<Exclude<A[K], undefined>> & { optional: true }
		: InputRule<A[K]>;
};

function invalid(): never {
	throw new Error("Invalid execution request arguments");
}
function rule<T>(check: (value: unknown) => boolean): InputRule<T> {
	return {
		validate(value) {
			if (!check(value)) invalid();
		},
	};
}
function record(value: unknown): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	);
}
function json(value: unknown, depth = 0, budget = { remaining: 100_000 }): boolean {
	if (depth > 64 || --budget.remaining < 0) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => json(item, depth + 1, budget));
	return (
		record(value) && Object.values(value).every((item) => item === undefined || json(item, depth + 1, budget))
	);
}

export const input = {
	text: rule<string>((value) => typeof value === "string"),
	id: rule<string>((value) => typeof value === "string" && value.length > 0),
	number: rule<number>((value) => typeof value === "number" && Number.isFinite(value)),
	boolean: rule<boolean>((value) => typeof value === "boolean"),
	optional<T>(value: InputRule<T>): InputRule<T> & { optional: true } {
		return { ...value, optional: true };
	},
	nullable<T>(value: InputRule<T>): InputRule<T | null> {
		return {
			validate(candidate) {
				if (candidate !== null) value.validate(candidate);
			},
		};
	},
	oneOf<const T extends readonly (string | number | boolean)[]>(...values: T): InputRule<T[number]> {
		return rule((candidate) => values.includes(candidate as T[number]));
	},
	array<T>(value: InputRule<T>): InputRule<T[]> {
		return {
			validate(candidate) {
				if (!Array.isArray(candidate)) invalid();
				for (const item of candidate) value.validate(item);
			},
		};
	},
	object<const T extends Record<string, InputRule<unknown>>>(
		fields: T,
	): InputRule<{ [K in keyof T]: NonNullable<T[K]["value"]> }> {
		return {
			validate(value) {
				validateArguments(fields, value);
			},
		};
	},
	jsonObject<T extends object>(): InputRule<T> {
		return rule((value) => record(value) && json(value));
	},
	union<T>(...rules: InputRule<T>[]): InputRule<T> {
		return {
			validate(value) {
				for (const candidate of rules) {
					try {
						candidate.validate(value);
						return;
					} catch {
						/* Try the next explicit shape. */
					}
				}
				invalid();
			},
		};
	},
};

export function validateArguments(
	fields: Record<string, InputRule<unknown>> | undefined,
	value: unknown,
): void {
	if (!fields) {
		if (value !== undefined) invalid();
		return;
	}
	if (!record(value) || !json(value)) invalid();
	for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) invalid();
	for (const [key, rule] of Object.entries(fields)) {
		if (value[key] === undefined && rule.optional) continue;
		rule.validate(value[key]);
	}
}
