const { app, BrowserWindow } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
app.setPath("userData", join(root, ".local/tmp/app-icon-render/user-data"));
app.setPath("sessionData", join(root, ".local/tmp/app-icon-render/session"));
app.whenReady().then(async () => {
	try {
		const win = new BrowserWindow({
			show: false,
			webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
		});
		await win.loadURL("data:text/html,<html></html>");
		for (const name of ["icon", "icon-beta", "icon-dev"]) {
			const svg = await readFile(join(root, `packages/desktop/build/${name}.svg`), "utf8");
			const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
			const data = await win.webContents.executeJavaScript(`(async()=>{
const image=new Image();image.src=${JSON.stringify(url)};await image.decode();
const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;
canvas.getContext('2d').drawImage(image,0,0);return canvas.toDataURL('image/png').split(',')[1];})()`);
			await writeFile(join(root, `packages/desktop/build/${name}.png`), Buffer.from(data, "base64"));
			console.log(`Rendered ${name}.png`);
		}
		app.quit();
	} catch (error) {
		console.error(error);
		app.exit(1);
	}
});
