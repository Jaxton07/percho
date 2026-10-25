import { cleanProjectExtraDirs, EMPTY_EXTRA_DIRS } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CloseIcon, FolderIcon, PlusIcon } from "../icons";

/**
 * 项目额外文件夹弹窗（左栏项目行 «⋯» → 编辑项目）。
 *
 * 语义（spec）：首个目录永远是项目 cwd（标「主要」、不可删），额外目录**只进系统提示词声明**——
 * 不改 cwd、不进 `.pi`/AGENTS.md/skills 的发现、不产生新分组。所以这里是一次纯粹的列表编辑：
 * 打开时把已存列表拷进本地草稿，「保存」才落盘（`setProjectExtraDirs` 内部按 shared 规则清洗）。
 *
 * 外观对齐 `ConfirmDialog`（同蒙层浓度、同卡片圆角/阴影/按钮排布）；层级也相同 z-[60] ——
 * 它同样从「菜单项 onSelect 先执行、菜单随后关闭」的路径打开，必须压过 z-50 的菜单。
 */
export function ProjectFoldersDialog({
	cwd,
	name,
	onClose,
}: {
	/** 项目主目录（= 会话 cwd）：列表第一行，也是清洗时「丢弃等于 cwd」的那个值 */
	cwd: string;
	/** 项目名（弹窗副标题里指代它；不做编辑） */
	name: string;
	onClose: () => void;
}) {
	const t = useT();
	const saved = useUiPreferencesStore((s) => s.projectExtraDirs[cwd] ?? EMPTY_EXTRA_DIRS);
	const setProjectExtraDirs = useUiPreferencesStore((s) => s.setProjectExtraDirs);
	// 草稿：只在保存时落盘（打开期间删掉的项再取消 = 原样恢复）
	const [dirs, setDirs] = useState<string[]>(saved);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current?.contains(e.target as Node)) return;
			onClose();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose]);

	// 系统目录选择器：取消（null）时什么都不做；选到已存在的目录/主目录由清洗规则自然去重
	const addFolder = async () => {
		const picked = await getPi()
			.pickDirectory()
			.catch(() => null);
		if (!picked) return;
		setDirs(cleanProjectExtraDirs(cwd, [...dirs, picked]));
	};

	return createPortal(
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/6" role="presentation">
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={t("projectFolders.title")}
				className="relative w-[420px] rounded-2xl bg-surface px-[22px] pt-5 pb-4 shadow-dialog"
			>
				<h2 className="pr-6 text-ui-19 font-bold tracking-[-0.01em] text-ink">{t("projectFolders.title")}</h2>
				<p className="mt-1 truncate text-ui-12 text-ink-faint" title={name}>
					{name}
				</p>
				<button
					type="button"
					className="absolute top-4 right-4 flex text-ink-faint transition-colors hover:text-ink-2"
					onClick={onClose}
					aria-label={t("projectFolders.cancel")}
				>
					<CloseIcon size={14} />
				</button>

				<div className="mt-3 max-h-[264px] overflow-y-auto rounded-xl border border-border p-1">
					{/* 主目录：恒第一行、标「主要」、不可删（它就是 cwd，删不掉也不该删） */}
					<div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-ui-13 text-ink">
						<FolderIcon size={14} />
						<span className="min-w-0 flex-1 truncate" title={cwd}>
							{cwd}
						</span>
						<span className="shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-ui-11 text-ink-dim">
							{t("projectFolders.primary")}
						</span>
					</div>
					{dirs.map((dir) => (
						<div
							key={dir}
							className="group/dir flex items-center gap-2 rounded-lg px-2 py-1.5 text-ui-13 text-ink-2 hover:bg-hover"
						>
							<FolderIcon size={14} />
							<span className="min-w-0 flex-1 truncate" title={dir}>
								{dir}
							</span>
							<button
								type="button"
								aria-label={t("projectFolders.remove", { path: dir })}
								className="shrink-0 text-ink-faint opacity-0 transition-colors group-hover/dir:opacity-100 hover:text-ink focus-visible:opacity-100"
								onClick={() => setDirs(dirs.filter((item) => item !== dir))}
							>
								<CloseIcon size={12} />
							</button>
						</div>
					))}
					{dirs.length === 0 && (
						<p className="px-2 py-3 text-center text-ui-12 text-ink-faint">{t("projectFolders.empty")}</p>
					)}
				</div>

				<button
					type="button"
					className="mt-1.5 flex h-7 items-center gap-1.5 rounded-lg px-2 text-ui-13 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => void addFolder()}
				>
					<PlusIcon size={13} />
					{t("projectFolders.addFolder")}
				</button>

				<p className="mt-2 text-ui-12 leading-[1.6] text-ink-faint">{t("projectFolders.hint")}</p>

				<div className="fade-rule my-3" />
				<div className="flex justify-end gap-2">
					<button
						type="button"
						className="flex h-8 items-center rounded-[9px] px-3.5 text-ui-13 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
						onClick={onClose}
					>
						{t("projectFolders.cancel")}
					</button>
					<button
						type="button"
						className="flex h-8 items-center rounded-[9px] bg-ink px-3.5 text-ui-13 font-medium text-on-ink transition-colors hover:bg-ink-2"
						onClick={() => {
							setProjectExtraDirs(cwd, dirs);
							onClose();
						}}
					>
						{t("projectFolders.save")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
