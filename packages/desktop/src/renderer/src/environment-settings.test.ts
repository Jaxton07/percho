import {
	type AvailableModel,
	type EnvironmentRef,
	environmentEntityKey,
	environmentKey,
	LOCAL_ENVIRONMENT,
} from "@percho/shared";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
	const api = () => ({
		listModels: vi.fn(async (): Promise<AvailableModel[]> => []),
		setContextManagerMode: vi.fn(async (_args: unknown) => {}),
		mcpConfigList: vi.fn(async (_args: unknown) => ({ global: [], project: [] })),
		listConfiguredPackages: vi.fn(async () => []),
		listGitBranches: vi.fn(async (_args: unknown) => ({ current: "main", branches: ["main"] })),
	});
	const remote = api();
	const local = { ...api(), forEnvironment: vi.fn(() => remote) };
	return { local, remote };
});
vi.mock("./api", () => ({ getPi: () => fixture.local }));

import { getExecutionApi } from "./environment-api";
import { getCatalogStore } from "./stores/catalog";
import { getMcpStore } from "./stores/mcp";
import { useSessionsStore } from "./stores/sessions";
import { getSettingsStore } from "./stores/settings";

const remote: EnvironmentRef = { kind: "ssh", connectionId: "company", environmentId: "data" };
const key = (id: string) => environmentEntityKey(remote, id);

describe("settings operation ownership", () => {
	it("late remote failure rolls back only its own settings after switching to a local project", async () => {
		const remoteStore = getSettingsStore(remote);
		const localStore = getSettingsStore(LOCAL_ENVIRONMENT);
		remoteStore.setState({ contextManagerMode: "off", error: null });
		localStore.setState({ contextManagerMode: "off", error: null });
		let fail!: (error: Error) => void;
		fixture.remote.setContextManagerMode.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		const pending = remoteStore.getState().setContextManagerMode("evaporation");
		useSessionsStore.setState({ activeSessionId: null, newSessionDraft: null, cwd: "/same" });
		await localStore.getState().setContextManagerMode("evaporation");
		fail(new Error("remote disk read-only"));
		await pending;
		expect(fixture.remote.setContextManagerMode).toHaveBeenCalledWith({ mode: "evaporation" });
		expect(remoteStore.getState().contextManagerMode).toBe("off");
		expect(localStore.getState().contextManagerMode).toBe("evaporation");
		expect(localStore.getState().error).toBeNull();
	});
	it("MCP, package catalog and Git use the captured environment and unwrap only the owned directory", async () => {
		await getMcpStore(remote).getState().load(key("/same"));
		await getCatalogStore(remote).getState().refreshConfiguredPackages();
		const git = getExecutionApi(key("/same"));
		useSessionsStore.setState({ cwd: "/elsewhere" });
		await git.listGitBranches({ cwd: key("/same") });
		expect(fixture.remote.mcpConfigList).toHaveBeenCalledWith({ cwd: "/same" });
		expect(fixture.remote.listConfiguredPackages).toHaveBeenCalledOnce();
		expect(fixture.remote.listGitBranches).toHaveBeenCalledWith({ cwd: "/same" });
		expect(fixture.local.mcpConfigList).not.toHaveBeenCalled();
		expect(fixture.local.listConfiguredPackages).not.toHaveBeenCalled();
		expect(fixture.local.listGitBranches).not.toHaveBeenCalled();
	});
});

it("a late remote model catalog is cached for its owner without replacing the local picker", async () => {
	const model: AvailableModel = {
		provider: "local",
		providerName: "Local",
		id: "local",
		label: "Local",
		authed: true,
	};
	useSessionsStore.setState({ activeSessionId: key("remote-session"), models: [] });
	let complete!: (models: AvailableModel[]) => void;
	fixture.remote.listModels.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const pending = useSessionsStore.getState().loadModels(remote);
	useSessionsStore.setState({ activeSessionId: null, newSessionDraft: null, models: [model] });
	complete([]);
	await pending;
	expect(useSessionsStore.getState().models).toEqual([model]);
	expect(useSessionsStore.getState().modelsByEnvironment[environmentKey(remote)]).toEqual([]);
	expect(fixture.local.listModels).not.toHaveBeenCalled();
});
