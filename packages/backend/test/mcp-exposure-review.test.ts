import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agent.dir,
}));
const { listMcpServers, upsertMcpServer } = await import("../src/mcp/config-store");

it("公开读写展示官方诊断且不静默修改其他非法配置", async () => {
	const base = resolve(process.cwd(), "../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-exposure-review-"));
	agent.dir = root;
	const path = join(root, "mcp.json");
	const raw = {
		mcpServers: {
			legacy: { command: "node", exposure: "model-only", extra: "keep" },
			valid: { command: "node", args: ["old"] },
		},
	};
	writeFileSync(path, JSON.stringify(raw));
	try {
		const list = await listMcpServers({ projectTrusted: true });
		expect(list.global.map((server) => server.name)).toContain("legacy");
		expect(list.global.find((server) => server.name === "legacy")).toMatchObject({
			exposureRaw: "model-only",
			exposure: "codemode",
		});
		expect(list.errors.join(" ")).toContain('server "legacy": exposure must be one of');
		await expect(
			upsertMcpServer({ scope: "user", name: "valid", command: "node", args: [] }, { projectTrusted: true }),
		).rejects.toThrow();
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(raw);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("公开写入用空数组清空参数", async () => {
	const base = resolve(process.cwd(), "../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-args-review-"));
	agent.dir = root;
	const path = join(root, "mcp.json");
	writeFileSync(
		path,
		JSON.stringify({ mcpServers: { valid: { command: "node", args: ["old"], env: { KEEP: "yes" } } } }),
	);
	try {
		await upsertMcpServer(
			{ scope: "user", name: "valid", command: "node", args: [] },
			{ projectTrusted: true },
		);
		expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.valid).toMatchObject({
			args: [],
			env: { KEEP: "yes" },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
