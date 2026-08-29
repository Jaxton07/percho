/** 音频资产（构建器 dataurl loader 内联为 data: URL；宿主 percho-ui.d.ts 同款声明，供编辑器类型） */
declare module "*.mp3" {
	const url: string;
	export default url;
}
declare module "*.m4a" {
	const url: string;
	export default url;
}
declare module "*.wav" {
	const url: string;
	export default url;
}
declare module "*.ogg" {
	const url: string;
	export default url;
}
