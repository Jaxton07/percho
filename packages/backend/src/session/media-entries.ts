import { isReferenceImage, type ReferenceImage } from "@percho/shared";
import type { SessionMediaStore } from "./media-store";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
export function displayDetails(entry: unknown, byId: ReadonlyMap<string, unknown>): RecordValue | null {
	if (
		!record(entry) ||
		entry.type !== "message" ||
		!record(entry.message) ||
		entry.message.role !== "toolResult" ||
		!record(entry.message.details)
	)
		return null;
	const message = entry.message;
	let name = message.toolName;
	if (name === undefined) {
		const visited = new Set<string>();
		let parent = entry.parentId;
		while (typeof parent === "string" && !visited.has(parent)) {
			visited.add(parent);
			const ancestor = byId.get(parent);
			if (!record(ancestor)) break;
			if (
				record(ancestor.message) &&
				ancestor.message.role === "assistant" &&
				Array.isArray(ancestor.message.content)
			) {
				const call = ancestor.message.content.find(
					(value) => record(value) && value.type === "toolCall" && value.id === message.toolCallId,
				);
				if (record(call)) {
					name = call.name;
					break;
				}
			}
			parent = ancestor.parentId;
		}
	}
	return name === "show_image" ? (message.details as RecordValue) : null;
}
function index(entries: readonly unknown[]): Map<string, RecordValue> {
	return new Map(
		entries
			.filter(record)
			.filter((entry) => typeof entry.id === "string")
			.map((entry) => [entry.id as string, entry]),
	);
}
function asset(value: unknown): ReferenceImage | null {
	if (!record(value) || value.kind !== "reference") return null;
	if (
		!isReferenceImage(value) ||
		!/^asset:[a-f0-9]{64}$/.test(value.id) ||
		value.revision !== value.id.slice(6)
	)
		throw new Error("Unsupported or corrupt persisted image reference");
	return value;
}

export function displayImageEntryIds(entries: readonly unknown[]): string[] {
	const byId = index(entries);
	return entries
		.filter((entry) => displayDetails(entry, byId))
		.filter(record)
		.filter((entry) => typeof entry.id === "string")
		.map((entry) => entry.id as string);
}

/** 所有保留记录而不是只看当前branch；未知字段和非show_image内容不动。 */
export function collectSessionAssets(entries: readonly unknown[]): ReferenceImage[] {
	const byId = index(entries),
		found = new Map<string, ReferenceImage>();
	for (const entry of entries) {
		const details = displayDetails(entry, byId);
		if (!details) continue;
		for (const image of Array.isArray(details.images) ? details.images : [details.image]) {
			const reference = asset(image);
			if (reference) found.set(reference.id, reference);
		}
	}
	return [...found.values()];
}

/** 自包含导出只回填已识别展示图，永不修改SDK树或源JSONL。owner取真实导出来源。 */
export async function inlineSessionAssets<T>(
	entries: readonly T[],
	owner: string,
	store: SessionMediaStore,
	maxEncodedBytes = Number.POSITIVE_INFINITY,
): Promise<T[]> {
	let encodedBytes = 0;
	const byId = index(entries),
		originals = new Map<string, Promise<{ data: string; mimeType: string }>>();
	const inflate = async (value: unknown) => {
		const reference = asset(value);
		if (!reference) return value;
		let work = originals.get(reference.id);
		if (!work) {
			work = store
				.read(owner, reference.id, reference.revision)
				.then(({ data, mimeType }) => ({ data, mimeType }));
			originals.set(reference.id, work);
		}
		const image = await work;
		encodedBytes += image.data.length;
		if (encodedBytes > maxEncodedBytes)
			throw new Error("Self-contained export exceeds the transport size budget");
		const {
			kind: _kind,
			ownerSessionId: _owner,
			id: _id,
			revision: _revision,
			byteLength: _length,
			mimeType: _mime,
			...extra
		} = reference;
		return { ...extra, ...image };
	};
	const result: T[] = [];
	for (const entry of entries) {
		const details = displayDetails(entry, byId);
		if (!details || !record(entry) || !record(entry.message)) {
			result.push(entry);
			continue;
		}
		const next = { ...details };
		if (Array.isArray(details.images)) next.images = await Promise.all(details.images.map(inflate));
		else if (details.image !== undefined) next.image = await inflate(details.image);
		result.push({ ...entry, message: { ...entry.message, details: next } } as T);
	}
	return result;
}
