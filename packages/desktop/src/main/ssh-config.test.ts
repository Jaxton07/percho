import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSshAliases } from "./ssh-config";

const base = fileURLToPath(new URL("../../../../.local/tmp/ssh-alias-discovery/", import.meta.url));
let home: string, config: string, systemConfig: string;
beforeEach(async () => {
	await mkdir(base, { recursive: true });
	home = await mkdtemp(join(base, "fixture-"));
	config = join(home, ".ssh", "config");
	systemConfig = join(home, "system", "ssh_config");
	await mkdir(join(home, ".ssh"), { recursive: true });
	await mkdir(join(home, "system"), { recursive: true });
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});
const discover = () => discoverSshAliases({ home, systemConfig });

describe("local SSH alias discovery", () => {
	it("collects concrete aliases, preserves order and ignores patterns, negations and connection options", async () => {
		await writeFile(
			config,
			'host=first second # comment\nHost * !excluded *.company [ab]host\nHOST "quoted" first\nHostName not-an-alias\nUser root\nHost -option bad/alias user@host\n',
		);
		await writeFile(systemConfig, "Host second system\n");
		expect(await discover()).toEqual({ aliases: ["first", "second", "quoted", "system"], incomplete: false });
	});
	it("follows quoted, nested and wildcard includes using the user/system root base, not the containing directory", async () => {
		await mkdir(join(home, ".ssh", "parts"));
		await writeFile(config, 'Include "parts/with space.conf" parts/missing-*.conf\nHost last\n');
		await writeFile(join(home, ".ssh", "parts", "with space.conf"), "Host included\nInclude root.conf\n");
		await writeFile(join(home, ".ssh", "root.conf"), "Host nested\n");
		await writeFile(systemConfig, "Include hosts.conf\n");
		await writeFile(join(home, "system", "hosts.conf"), "Host system\n");
		expect(await discover()).toEqual({
			aliases: ["included", "nested", "last", "system"],
			incomplete: false,
		});
	});
	it("reads wildcard matches and terminates include cycles without duplicates", async () => {
		await mkdir(join(home, ".ssh", "parts"));
		await writeFile(config, "Include parts/*.conf\nHost root\n");
		await writeFile(join(home, ".ssh", "parts", "a.conf"), "Host alpha\nInclude config\n");
		await writeFile(join(home, ".ssh", "parts", "b.conf"), "Host beta alpha\n");
		const result = await discover();
		expect(new Set(result.aliases)).toEqual(new Set(["alpha", "beta", "root"]));
		expect(result.aliases).toHaveLength(3);
		expect(result.incomplete).toBe(false);
	});
	it("does not execute Match commands or read private-key directives; conditional hosts are only candidates", async () => {
		const sentinel = join(home, "must-not-exist");
		const key = join(home, "private-key");
		await writeFile(key, "Host never-from-private-key\n");
		await writeFile(
			config,
			`IdentityFile "${key}"\nMatch exec "touch '${sentinel}'"\nInclude conditional.conf\nHost literal\n`,
		);
		await writeFile(join(home, ".ssh", "conditional.conf"), "Host conditional\n");
		expect(await discover()).toEqual({ aliases: ["conditional", "literal"], incomplete: false });
		await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("missing configuration is an ordinary empty result", async () => {
		expect(await discover()).toEqual({ aliases: [], incomplete: false });
	});
	it("expands home includes but does not turn missing variables into another file", async () => {
		await writeFile(config, `Include "~/home.conf" \${PERCHO_SSH_DISCOVERY_TEST_UNSET}.conf\nHost last\n`);
		await writeFile(join(home, "home.conf"), "Host from-home\n");
		await writeFile(join(home, ".ssh", ".conf"), "Host wrong-file\n");
		expect(await discover()).toEqual({ aliases: ["from-home", "last"], incomplete: true });
	});
	it("limits nested configuration depth while retaining other aliases", async () => {
		await writeFile(config, "Include level0\nHost kept\n");
		for (let i = 0; i < 12; i++) await writeFile(join(home, ".ssh", `level${i}`), `Include level${i + 1}\n`);
		expect(await discover()).toEqual({ aliases: ["kept"], incomplete: true });
	});
	it("keeps discovered aliases when unsupported includes or malformed quotes occur", async () => {
		await writeFile(config, 'Host first\nInclude %h.conf\nInclude "unterminated\nHost last\n');
		expect(await discover()).toEqual({ aliases: ["first", "last"], incomplete: true });
	});
	it("refuses directories and oversized files, but still reads the other configuration root", async () => {
		await mkdir(join(home, ".ssh", "not-a-file"));
		await writeFile(config, "Include not-a-file huge.conf\nHost kept\n");
		await writeFile(join(home, ".ssh", "huge.conf"), "#".repeat(1024 * 1024 + 1));
		await writeFile(systemConfig, "Host system\n");
		expect(await discover()).toEqual({ aliases: ["kept", "system"], incomplete: true });
	});
	it("bounds alias output without expanding wildcard hosts", async () => {
		await writeFile(config, `Host ${Array.from({ length: 600 }, (_, i) => `host-${i}`).join(" ")}\n`);
		const result = await discover();
		expect(result.aliases).toHaveLength(512);
		expect(result.incomplete).toBe(true);
	});
});
