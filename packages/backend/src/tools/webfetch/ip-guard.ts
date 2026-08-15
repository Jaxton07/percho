import dns from "node:dns";
import { isIP } from "node:net";

/** 已解析的 IPv4 CIDR（base 为 32 位大整数） */
export interface Cidr {
	base: bigint;
	bits: number;
}

export function v4ToInt(ip: string): bigint {
	return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** 从 v4-mapped/v4-translated IPv6（::ffff: 前缀）提取低 32 位对应的 IPv4；非该形式返回 undefined。
 *  同时支持点分（::ffff:198.18.0.45）与十六进制（::ffff:0:c612:2d）两种系统解析器输出。 */
function v4FromMappedV6(ip6: string): string | undefined {
	const lower = ip6.toLowerCase();
	if (!lower.startsWith("::ffff:")) return undefined;
	const rest = lower.slice(7);
	if (rest.includes(".")) return rest;
	const groups = rest
		.split(":")
		.slice(-2)
		.map((group) => group.padStart(4, "0"));
	const hex = groups.join("");
	if (hex.length !== 8) return undefined;
	return [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(".");
}

/** 把（可能压缩的）IPv6 展开成 8 个四位十六进制组；尾部点分 v4（64:ff9b::127.0.0.1）一并转换。无法展开返回 undefined */
function expandV6(ip6: string): string[] | undefined {
	let s = ip6.toLowerCase();
	if (s.includes(".")) {
		const idx = s.lastIndexOf(":");
		const v4 = s.slice(idx + 1);
		if (isIP(v4) !== 4) return undefined;
		const parts = v4.split(".").map(Number);
		const hi = (((parts[0] ?? 0) << 8) | (parts[1] ?? 0)).toString(16);
		const lo = (((parts[2] ?? 0) << 8) | (parts[3] ?? 0)).toString(16);
		s = `${s.slice(0, idx)}:${hi}:${lo}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
	const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
	return groups.map((g) => g.padStart(4, "0"));
}

/** 取展开后 IPv6 最后两组对应的点分 IPv4 */
function v4FromLastGroups(g6: string, g7: string): string {
	const hex = `${g6}${g7}`;
	return [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(".");
}

/**
 * 判断 IP 是否为私网/保留地址（SSRF 拦截用）。
 * 覆盖 IPv4 私网段、回环、链路本地、CGNAT、组播/保留段；
 * IPv6 回环/ULA/链路本地/站点本地/组播，以及内嵌 v4 的 v4-mapped、v4-compatible（::/96）、NAT64（64:ff9b::/96）。
 */
export function isPublicIp(ip: string): boolean {
	if (isIP(ip) === 4) {
		const parts = ip.split(".").map(Number);
		const a = parts[0] ?? 0;
		const b = parts[1] ?? 0;
		if (a === 0 || a === 10) return false;
		if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
		if (a === 127) return false;
		if (a === 169 && b === 254) return false; // 链路本地
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && (b === 0 || b === 168)) return false;
		if (a >= 224) return false; // 组播 + 保留
		return true;
	}
	if (isIP(ip) === 6) {
		const groups = expandV6(ip);
		if (!groups) return false;
		const first = Number.parseInt(groups[0] ?? "0", 16);
		if (first >= 0xff00) return false; // ff00::/8 组播
		if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 链路本地
		if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
		if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 废弃站点本地
		const firstFiveZero = groups.slice(0, 5).every((g) => g === "0000");
		if (firstFiveZero && (groups[5] === "0000" || groups[5] === "ffff")) {
			// ::/96 v4-compatible（含 ::、::1，内嵌 0.x/127.x 由 v4 规则拦）与 ::ffff:/96 v4-mapped
			return isPublicIp(v4FromLastGroups(groups[6] ?? "0", groups[7] ?? "0"));
		}
		if (groups[0] === "0064" && groups[1] === "ff9b") {
			// NAT64 64:ff9b::/96 内嵌 IPv4（64:ff9b::7f00:1 = 127.0.0.1）
			return isPublicIp(v4FromLastGroups(groups[6] ?? "0", groups[7] ?? "0"));
		}
		return true;
	}
	return false;
}

/** 解析 "a.b.c.d/n" 形式的 IPv4 CIDR */
export function parseCidr(cidr: string): Cidr {
	const [base, bitsPart] = cidr.split("/");
	const bits = Number(bitsPart);
	if (!bitsPart || !Number.isInteger(bits) || bits < 0 || bits > 32 || isIP(base ?? "") !== 4) {
		throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
	}
	return { base: v4ToInt(base ?? ""), bits };
}

/** IP 是否落在 CIDR 内；仅支持 IPv4（含 v4-mapped IPv6），其余返回 false */
export function ipInCidr(ip: string, cidr: Cidr): boolean {
	let v4: string | undefined;
	if (isIP(ip) === 4) {
		v4 = ip;
	} else if (isIP(ip) === 6) {
		v4 = v4FromMappedV6(ip);
	}
	if (!v4 || isIP(v4) !== 4) return false;
	const mask = cidr.bits === 0 ? 0n : (~0n << BigInt(32 - cidr.bits)) & 0xffffffffn;
	return (v4ToInt(v4) & mask) === (cidr.base & mask);
}

/** 198.18.0.0/15：RFC 2544 基准测试段，clash/surge/sing-box 类 fake-ip DNS 代理的默认段。
 *  该段不可路由、无真实服务，拦它只会在代理环境下让 webfetch 全挂，故默认放行。 */
export const FAKE_IP_CIDR: Cidr = { base: 0xc6120000n, bits: 15 };

/** 校验 URL 只允许公开 http(s) 目标；host 解析后任一地址非公网且不在 allowRanges 即拦截。
 *  注意：这是 best-effort 预检 —— fetch 内部会自行再做一次 DNS 解析，与本次校验存在 TOCTOU 窗口
 * （DNS rebinding 可让两次解析结果不同）。完备防护需在连接层钉住已验证 IP；
 * 目前与 pi-web-access 等同类实现水位一致。 */
export async function assertPublicUrl(rawUrl: string, allowRanges: Cidr[] = []): Promise<URL> {
	const isAllowed = (addr: string) => isPublicIp(addr) || allowRanges.some((cidr) => ipInCidr(addr, cidr));
	const url = new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`webfetch only supports http:// and https:// URLs (got ${url.protocol})`);
	}
	if (url.username || url.password) {
		throw new Error("URL must not contain credentials");
	}
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	if (isIP(host)) {
		if (!isAllowed(host)) throw new Error(`Blocked URL: private address ${host}`);
		return url;
	}
	let addresses: string[];
	try {
		addresses = (await dns.promises.lookup(host, { all: true })).map((entry) => entry.address);
	} catch {
		throw new Error(`Could not resolve host: ${url.hostname}`);
	}
	if (addresses.length === 0 || addresses.some((addr) => !isAllowed(addr))) {
		throw new Error(`Blocked URL: ${url.hostname} resolves to a non-public address`);
	}
	return url;
}
