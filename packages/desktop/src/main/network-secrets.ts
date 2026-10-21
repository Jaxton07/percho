import { safeStorage } from "electron";
import type { NetworkSecretCodec } from "./network-settings";

/** 只在应用就绪后使用系统凭据加密；不把代理密码明文写入配置文件。 */
export const networkSecrets: NetworkSecretCodec = {
	available: () =>
		safeStorage.isEncryptionAvailable() &&
		(process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
	encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
	decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
};
