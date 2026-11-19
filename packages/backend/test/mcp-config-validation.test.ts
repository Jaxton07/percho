import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateMcpConfigs } from "../src/mcp/config-validation";

const sdkRoot = resolve(process.cwd(), "../../node_modules/@earendil-works/pi-coding-agent/dist");
const { loadMcpConfig } = (await import(join(sdkRoot, "extensions/mcp/config.js"))) as {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): { errors: string[] };
};

describe("MCP validation against official loader", () => {
	it("matches official loader for transport, exposure, auth, OAuth and project overrides", () => {
		const base = resolve(process.cwd(), "../../.local/tmp");
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "mcp-validation-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const cases = [
			[{ command: "node", url: "https://example.com" }, undefined],
			[{ url: "https://example.com", exposure: "invalid" }, undefined],
			[{ command: "node", toolExposure: { test: "invalid" } }, undefined],
			[{ url: "http://example.com", auth: { provider: "test" } }, undefined],
			[{ url: "https://example.com", auth: { provider: "test" } }, { enabled: false }],
			[
				{ url: "https://example.com", oauth: { clientRegistration: "cimd", callbackUrl: "not a url" } },
				undefined,
			],
		] as const;
		for (const [globalServer, projectServer] of cases) {
			const global = { mcpServers: { test: globalServer } };
			const project = { mcpServers: projectServer ? { test: projectServer } : {} };
			writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
			writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify(project));
			const official = loadMcpConfig({ agentDir, cwd, projectTrusted: true });
			expect(validateMcpConfigs(global, project).length === 0, JSON.stringify(globalServer)).toBe(
				official.errors.length === 0,
			);
		}
	});
});
