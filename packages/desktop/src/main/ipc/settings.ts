import type { PiBackend } from "@percho/backend";
import type {
	CustomProviderInput,
	CustomProviderUpdateInput,
	ListProvidersOptions,
	PermissionAnswer,
	VisionSaveInput,
} from "@percho/shared";
import { IpcChannels } from "@percho/shared";
import { ipcMain } from "electron";

/** 设置域：provider 设置 + 权限门控配置 + 视觉代理 + 项目信任应答 */
export function registerSettingsIpc(backend: PiBackend): void {
	ipcMain.handle(IpcChannels.SettingsListProviders, (_e, options?: ListProvidersOptions) =>
		backend.settings.listProviders(options),
	);
	ipcMain.handle(IpcChannels.SettingsSaveApiKey, (_e, providerId: string, key: string) =>
		backend.settings.saveApiKey(providerId, key),
	);
	ipcMain.handle(IpcChannels.SettingsRemoveCredential, (_e, providerId: string) =>
		backend.settings.removeCredential(providerId),
	);
	ipcMain.handle(IpcChannels.SettingsAddCustomProvider, (_e, input: CustomProviderInput) =>
		backend.settings.addCustomProvider(input),
	);
	ipcMain.handle(IpcChannels.SettingsUpdateCustomProvider, (_e, input: CustomProviderUpdateInput) =>
		backend.settings.updateCustomProvider(input),
	);
	ipcMain.handle(IpcChannels.SettingsRemoveCustomProvider, (_e, providerId: string) =>
		backend.settings.removeCustomProvider(providerId),
	);
	ipcMain.handle(IpcChannels.SettingsTestProvider, (_e, providerId: string, modelId?: string) =>
		backend.settings.testProvider(providerId, modelId),
	);
	ipcMain.handle(IpcChannels.SettingsLoginStart, (_e, loginId: string, providerId: string) =>
		backend.login.startLogin(loginId, providerId),
	);
	ipcMain.handle(IpcChannels.SettingsLoginCancel, (_e, loginId: string) => backend.login.cancel(loginId));
	ipcMain.handle(IpcChannels.SettingsLoginRespond, (_e, loginId: string, promptId: string, value: string) =>
		backend.login.respond(loginId, promptId, value),
	);
	ipcMain.handle(IpcChannels.PermissionRespond, (_e, requestId: string, answer: PermissionAnswer) =>
		backend.respondPermission(requestId, answer),
	);
	ipcMain.handle(IpcChannels.PermissionGetConfig, () => backend.getPermissionConfig());
	ipcMain.handle(IpcChannels.PermissionSetEnabled, (_e, enabled: boolean) =>
		backend.setPermissionEnabled(enabled),
	);
	ipcMain.handle(IpcChannels.VisionGetConfig, () => backend.getVisionConfig());
	ipcMain.handle(IpcChannels.VisionSaveConfig, (_e, input: VisionSaveInput) =>
		backend.saveVisionConfig(input),
	);
	ipcMain.handle(IpcChannels.VisionTest, () => backend.testVision());
	ipcMain.handle(IpcChannels.VisionSetLanguage, (_e, language: "zh" | "en") =>
		backend.setVisionLanguage(language),
	);
	ipcMain.handle(IpcChannels.TrustRespond, (_e, requestId: string, answer: number) =>
		backend.respondTrust(requestId, answer),
	);
}
