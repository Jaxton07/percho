import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { CHANNEL_TABLE, IpcChannels, type PiApi, SUBSCRIPTION_TABLE } from "@percho/shared";
import { buildSync } from "esbuild";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Historical compatibility data, not another production definition or payload registry.
const LEGACY_SUBSCRIPTION_SNAPSHOT = [
	["onProviderLoginEvent", "SettingsLoginEvent", "settings:loginEvent"],
	["onMcpServersChanged", "McpServersChanged", "mcp:serversChanged"],
	["onChannelSubscriptionsChanged", "ChannelSubscriptionsChanged", "channel:subscriptionsChanged"],
	["onUiPluginsEvent", "UiPluginsEvent", "uiPlugins:event"],
	["onQuitRequested", "QuitRequested", "app:quit-requested"],
	["onUpdateEvent", "UpdateEvent", "update:event"],
	["onEvent", "Event", "pi:event"],
	["onPermissionRequest", "PermissionRequest", "pi:permission-request"],
	["onPermissionResolved", "PermissionResolved", "pi:permission-resolved"],
	["onTrustRequest", "TrustRequest", "pi:trust-request"],
	["onExtensionDialogRequest", "ExtensionDialogRequest", "pi:extension-dialog-request"],
	["onExtensionDialogResolved", "ExtensionDialogResolved", "pi:extension-dialog-resolved"],
	["onExtensionNotify", "ExtensionNotify", "pi:extension-notify"],
	["onExtensionEditorText", "ExtensionEditorText", "pi:extension-editor-text"],
];
const PRELOAD = resolve(__dirname, "../../preload/index.ts");
const SEND = resolve(__dirname, "../../main/ipc/send.ts");
const SHARED = resolve(__dirname, "../../../../shared/src/index.ts");
const code = buildSync({
	entryPoints: [PRELOAD],
	bundle: true,
	platform: "node",
	format: "cjs",
	write: false,
	external: ["electron"],
}).outputFiles[0]?.text;
type Listener = (event: unknown, payload?: unknown) => void;
function bootPreload() {
	if (!code) throw new Error("preload bundle missing");
	let exposed: PiApi | undefined;
	const listeners = new Map<string, Set<Listener>>();
	const ipc = {
		on: vi.fn((channel: string, listener: Listener) => {
			const set = listeners.get(channel) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(channel, set);
		}),
		removeListener: vi.fn((channel: string, listener: Listener) => {
			listeners.get(channel)?.delete(listener);
		}),
		invoke: vi.fn(async (_channel: string, _args: unknown) => "invoke-result"),
	};
	const getPathForFile = vi.fn((_file: unknown) => "/fixture/image.png");
	runInNewContext(code, {
		module: { exports: {} },
		exports: {},
		process: { platform: "darwin" },
		require: (name: string) => {
			if (name !== "electron") throw new Error(`non-sandbox require: ${name}`);
			return {
				ipcRenderer: ipc,
				webUtils: { getPathForFile },
				contextBridge: {
					exposeInMainWorld: (name: string, api: PiApi) => {
						expect(name).toBe("pi");
						exposed = api;
					},
				},
			};
		},
	});
	if (!exposed) throw new Error("preload did not expose API");
	return { api: exposed, ipc, listeners, getPathForFile };
}

describe("single-source subscription contract and real bundled preload", () => {
	it("keeps all legacy API names/channel values/explicit aliases, including login's irregular alias", () => {
		for (const [name, alias, channel] of LEGACY_SUBSCRIPTION_SNAPSHOT) {
			expect(SUBSCRIPTION_TABLE[name as keyof typeof SUBSCRIPTION_TABLE]).toMatchObject({ alias, channel });
		}
		const definitions = Object.values(SUBSCRIPTION_TABLE);
		expect(new Set(definitions.map((def) => def.alias)).size).toBe(definitions.length);
		expect(new Set(definitions.map((def) => def.channel)).size).toBe(definitions.length);
		for (const def of definitions) expect(IpcChannels[def.alias]).toBe(def.channel);
	});
	it("every table entry actually subscribes, transparently passes payload and removes its exact listener", () => {
		const { api, ipc } = bootPreload();
		for (const method of Object.keys(SUBSCRIPTION_TABLE) as Array<keyof typeof SUBSCRIPTION_TABLE>) {
			const def = SUBSCRIPTION_TABLE[method];
			const cb = vi.fn<(...args: unknown[]) => void>();
			const off = api[method](cb);
			const registered = ipc.on.mock.calls.at(-1);
			expect(registered?.[0]).toBe(def.channel);
			const listener = registered?.[1];
			if (!listener) throw new Error(`missing listener for ${method}`);
			const payload = { sentinel: method };
			listener({ nativeEvent: true }, payload);
			expect(cb.mock.calls).toEqual([def.noPayload ? [] : [payload]]);
			if (!def.noPayload) expect(cb.mock.calls[0]?.[0]).toBe(payload);
			off();
			expect(ipc.removeListener.mock.calls.at(-1)).toEqual([def.channel, listener]);
		}
	});
	it("independent subscriptions do not unsubscribe each other; quit invokes its callback with zero arguments", () => {
		const { api, listeners } = bootPreload();
		const first = vi.fn(),
			second = vi.fn();
		const offFirst = api.onUiPluginsEvent(first),
			offSecond = api.onUiPluginsEvent(second);
		offFirst();
		offFirst();
		const payload = { kind: "config" };
		for (const listener of listeners.get(IpcChannels.UiPluginsEvent) ?? []) listener({}, payload);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledWith(payload);
		offSecond();
		expect(listeners.get(IpcChannels.UiPluginsEvent)?.size).toBe(0);
		const quit = vi.fn();
		api.onQuitRequested(quit);
		for (const listener of listeners.get(IpcChannels.QuitRequested) ?? []) listener({});
		expect(quit.mock.calls).toEqual([[]]);
	});
	it("native synchronous fields and independent invoke construction remain unchanged", async () => {
		const { api, ipc, getPathForFile } = bootPreload();
		expect(api.platform).toBe("darwin");
		const file = { name: "image.png" };
		expect(api.getPathForFile(file)).toBe("/fixture/image.png");
		expect(getPathForFile).toHaveBeenCalledWith(file);
		for (const name of Object.keys(CHANNEL_TABLE) as Array<keyof typeof CHANNEL_TABLE>)
			expect(api[name]).toBeTypeOf("function");
		const args = { cwd: "/fixture/project" };
		expect(await api.listSessions(args)).toBe("invoke-result");
		expect(ipc.invoke).toHaveBeenLastCalledWith(CHANNEL_TABLE.listSessions.channel, args);
		expect(ipc.invoke.mock.calls.at(-1)?.[1]).toBe(args);
		await api.getQuota();
		expect(ipc.invoke).toHaveBeenLastCalledWith(CHANNEL_TABLE.getQuota.channel, undefined);
	});
});

function compileFixture(body: string) {
	const root = mkdtempSync(join(tmpdir(), "percho-subscription-types-"));
	try {
		const file = join(root, "fixture.ts");
		// Resolve the real public barrel explicitly: temp fixtures need not have workspace node_modules ancestors.
		const source = `import { IpcChannels, type PiApi } from ${JSON.stringify(SHARED)};\nimport { sendToRenderer, forward } from ${JSON.stringify(SEND)};\ndeclare const api: PiApi;\n${body}`;
		writeFileSync(file, source);
		const configPath = resolve(__dirname, "../../../tsconfig.node.json");
		const config = ts.readConfigFile(configPath, ts.sys.readFile);
		if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."));
		const program = ts.createProgram([file], {
			...parsed.options,
			composite: false,
			incremental: false,
			noEmit: true,
			allowImportingTsExtensions: true,
		});
		return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
			file: diagnostic.file?.fileName === file ? "fixture" : diagnostic.file?.fileName,
			line:
				diagnostic.file && diagnostic.start !== undefined
					? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
					: 0,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		}));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
describe("actual TypeScript diagnostics, not uncompiled @ts-expect-error comments", () => {
	it("accepts matching main send/forward, consumer payload inference and void unsubscribe/quit", () => {
		expect(
			compileFixture(`sendToRenderer(IpcChannels.UiPluginsEvent, {kind: "config"});
forward((handler: (payload: {kind: "config"}) => void) => handler({kind:"config"}), IpcChannels.UiPluginsEvent);
api.onUiPluginsEvent(payload => { const kind: string = payload.kind; });
const off: () => void = api.onQuitRequested(() => {}); off();
sendToRenderer(IpcChannels.QuitRequested, undefined);`),
		).toEqual([]);
	}, 20000);
	it("rejects wrong send payload, source, callback, zero-arg quit, return type and unknown channel", () => {
		const diagnostics = compileFixture(`sendToRenderer(IpcChannels.UiPluginsEvent, {unexpected: 1});
forward((handler: (payload: number) => void) => handler(1), IpcChannels.UiPluginsEvent);
api.onUiPluginsEvent((payload: number) => {});
api.onQuitRequested((payload: undefined) => {});
const bad: Promise<void> = api.onQuitRequested(() => {});
sendToRenderer("invalid:channel", undefined);
sendToRenderer(IpcChannels.PermissionRequest, {kind: "config"});
forward((handler: (payload: {kind: "config"}) => void) => handler({kind:"config"}), IpcChannels.PermissionRequest);`);
		expect(diagnostics.filter((diagnostic) => diagnostic.file !== "fixture")).toEqual([]);
		for (const line of [4, 5, 6, 7, 8, 9, 10, 11])
			expect(
				diagnostics.some((diagnostic) => diagnostic.line === line),
				JSON.stringify(diagnostics),
			).toBe(true);
	}, 20000);
});
