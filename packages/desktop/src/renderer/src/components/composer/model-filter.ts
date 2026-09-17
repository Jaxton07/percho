import type { AvailableModel } from "@percho/shared";

/** 模型弹层的分组结构：provider 显示名 + 该 provider 下的模型 */
export interface ModelGroup {
	name: string;
	items: AvailableModel[];
}

/** 单条模型的可搜索文本：label / provider 显示名 / provider id / 模型 id */
function haystack(model: AvailableModel, groupName: string): string {
	return `${model.label} ${groupName} ${model.provider} ${model.id}`.toLowerCase();
}

/**
 * 模型搜索过滤：大小写不敏感 + 空格分词（所有词都要命中，`claude haiku` 能匹配到
 * `Claude 3.5 Haiku`）。匹配范围 = label / provider 名 / provider id / 模型 id。
 * 只保留含命中项的分组（空组丢弃），组与组内顺序不变；空 query 原样返回。
 */
export function filterModelGroups(groups: ModelGroup[], query: string): ModelGroup[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return groups;
	const result: ModelGroup[] = [];
	for (const group of groups) {
		const items = group.items.filter((model) => {
			const text = haystack(model, group.name);
			return terms.every((term) => text.includes(term));
		});
		if (items.length > 0) result.push({ name: group.name, items });
	}
	return result;
}
