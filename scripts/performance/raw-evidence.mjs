const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const number = Number.isFinite;
const completed = (value) => object(value) && (!("status" in value) || value.status === "passed");
const rows = (value, validate) =>
	Array.isArray(value) && value.length > 0 && value.every((row) => completed(row) && validate(row));

// Validate only the identifying sampling structure, not derived statistics or authenticity.
export function validRawEvidence(name, data) {
	if (!completed(data)) return false;
	switch (name) {
		case "minimap":
			return (
				text(data.mode) &&
				object(data.window) &&
				rows(data.samples, (row) => text(row.name) && number(row.elapsedMs))
			);
		case "rendering":
			return text(data.label) && rows(data.samples, (row) => text(row.stage) && number(row.elements));
		case "large-text":
			return (
				(data.status === "passed" || (data.version !== 2 && data.status == null)) &&
				rows(
					data.samples,
					(row) =>
						[row.navigation, row.ready, row.firstPaint, row.views].every(number) &&
						typeof row.warmup === "boolean",
				)
			);
		case "switch":
			return (
				data.version != null &&
				Array.isArray(data.summary) &&
				data.summary.length > 0 &&
				rows(
					data.samples,
					(row) =>
						text(row.fixture) &&
						(number(row.firstPaint) ||
							(object(row.firstPaint) && Object.values(row.firstPaint).some(number))),
				)
			);
		case "images":
			return rows(data.cases, (row) => text(row.mode) && number(row.imageCount) && row.imageCount > 0);
		case "catalog":
			return (
				Array.isArray(data.budgetFailures) &&
				data.budgetFailures.length === 0 &&
				rows(data.phases, (row) => text(row.phase) && number(row.refreshTotalMs))
			);
		default:
			return false;
	}
}
