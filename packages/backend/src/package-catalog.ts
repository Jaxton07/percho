import type { CatalogPackage, CatalogSearchResult } from "@percho/shared";
import { createLogger } from "./log";

const log = createLogger("package-catalog");

const CATALOG_BASE = "https://pi.dev/packages";
const PAGE_SIZE = 50;
const FETCH_TIMEOUT_MS = 15_000;

/** pi.dev 无公开 JSON API（/api/* 返回 501），包数据内嵌在 SSR HTML 的 data-* 属性与卡片结构里；
   搜索参数 ?name= 服务端模糊匹配名称/描述/作者，?type= 过滤类型，?page= 分页 */

const VALID_TYPES = new Set(["extension", "skill", "prompt", "theme"]);

/** 解码卡片 HTML 里的常见实体（描述文本用） */
export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&#x27;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function pick(html: string, pattern: RegExp): string {
	const m = pattern.exec(html);
	return m?.[1] ?? "";
}

/** 解析单张卡片 <article data-package-card="true">…</article> */
function parseCard(card: string): CatalogPackage | null {
	const name = pick(card, /data-package-name="([^"]+)"/);
	if (!name) return null;
	const typesRaw = pick(card, /data-package-types="([^"]*)"/);
	const types = typesRaw.trim().split(/\s+/).filter(Boolean);
	const downloads = Number(pick(card, /data-package-downloads="(\d+)"/) || 0);
	const updatedAt = Number(pick(card, /data-package-date="(\d+)"/) || 0);
	const description = decodeHtmlEntities(pick(card, /<p class="packages-desc">([\s\S]*?)<\/p>/).trim());
	const author = pick(card, /<div class="packages-meta">\s*<span>([^<]*)<\/span>/).trim();
	return {
		name,
		description,
		author,
		types: types.length > 0 ? types : ["package"],
		downloads,
		updatedAt,
		installSource: `npm:${name}`,
	};
}

/** 解析目录页 HTML：卡片列表 + 总数（"1-50 / 5472" 分页文案） */
export function parseCatalogHtml(html: string): { packages: CatalogPackage[]; total: number } {
	const packages: CatalogPackage[] = [];
	const cardPattern = /<article[^>]*data-package-card="true"[\s\S]*?<\/article>/g;
	for (const m of html.matchAll(cardPattern)) {
		const pkg = parseCard(m[0]);
		if (pkg) packages.push(pkg);
	}
	const totalText = pick(html, /\d+-\d+\s*\/\s*([\d,]+)/);
	const total = totalText ? Number(totalText.replace(/,/g, "")) : packages.length;
	return { packages, total };
}

export interface CatalogQuery {
	query?: string;
	type?: string;
	page?: number;
}

/** 抓取 pi.dev 社区包目录（服务端搜索/过滤/分页） */
export async function fetchPackageCatalog(q: CatalogQuery): Promise<CatalogSearchResult> {
	const url = new URL(CATALOG_BASE);
	const query = q.query?.trim();
	if (query) url.searchParams.set("name", query);
	if (q.type && VALID_TYPES.has(q.type)) url.searchParams.set("type", q.type);
	const page = Math.max(1, Math.floor(q.page ?? 1));
	if (page > 1) url.searchParams.set("page", String(page));

	log.info("fetch catalog", url.toString());
	const res = await fetch(url, {
		headers: { "User-Agent": "percho", Accept: "text/html" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`pi.dev returned HTTP ${res.status}`);
	const html = await res.text();
	const { packages, total } = parseCatalogHtml(html);
	return { packages, total, page, pageSize: PAGE_SIZE };
}
