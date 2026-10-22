import { type RefObject, useEffect, useState } from "react";
import { getPi } from "../../api";
import { type AtToken, extractAtToken, filterFiles } from "./at-files";
import type { ComposerEditorHandle } from "./ComposerEditor";

export interface UseAtCompletionOptions {
	cwd: string | null;
	text: string;
	draftKey: string;
	slashOpen: boolean;
	editorRef: RefObject<ComposerEditorHandle | null>;
}

/**
 * @ 文件补全域：光标前 @ token 探测 + 项目文件列表拉取（每 cwd 一次）+
 * 选中/续钻 + 胶囊移除回填 + 键盘导航。
 */
export function useAtCompletion(options: UseAtCompletionOptions) {
	const { cwd, text, slashOpen } = options;
	const [atToken, setAtToken] = useState<AtToken | null>(null);
	const [tokenOwner, setTokenOwner] = useState("");
	const owner = JSON.stringify([options.draftKey, cwd]);
	const [atFiles, setAtFiles] = useState<string[]>([]);
	const [atFilesCwd, setAtFilesCwd] = useState<string | null>(null);
	const [atSelected, setAtSelected] = useState(0);
	const [atDismissed, setAtDismissed] = useState(false);

	/** @ 菜单：token 仍与当前文本一致才有效（程序化清空文本后自动失效），slash 打开时不竞争 */
	const atOpen =
		atToken !== null &&
		tokenOwner === owner &&
		atFilesCwd === cwd &&
		text.slice(atToken.start, atToken.end) === `@${atToken.query}` &&
		!atDismissed &&
		!slashOpen;
	const atFiltered =
		atOpen && atToken
			? filterFiles(atFiles, atToken.query).filter((path) => path !== atToken.query || !path.endsWith("/"))
			: [];

	// 旧菜单不能作用于另一会话或另一项目。
	// biome-ignore lint/correctness/useExhaustiveDependencies: draftKey/cwd 是菜单目标身份，切换时必须清除
	useEffect(() => {
		setAtToken(null);
		setAtDismissed(false);
	}, [options.draftKey, cwd]);

	// @ token 出现时拉取项目文件列表（每 cwd 一次，backend TTL 缓存；atToken 击键频变但条件拦截）
	useEffect(() => {
		if (!atToken || !cwd || atFilesCwd === cwd) return;
		let cancelled = false;
		void getPi()
			.listProjectFiles({ cwd })
			.then((list) => {
				if (cancelled) return;
				setAtFiles(list);
				setAtFilesCwd(cwd);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [atToken, cwd, atFilesCwd]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: @ 查询词变化时重置选中项
	useEffect(() => {
		setAtSelected(0);
	}, [atToken?.query]);

	/** 文本变化后探测光标前 @ token（由 Composer 的 handleTextChange 调用） */
	const updateToken = (value: string, cursor: number) => {
		setTokenOwner(owner);
		setAtToken(extractAtToken(value, cursor));
	};

	/** 选中文件/目录：文件 → @ 胶囊（token 从文本移除）；目录续钻（菜单保持，query 变为目录路径） */
	const handleAtPick = (path: string) => {
		if (!atToken || !atOpen) return;
		const isDir = path.endsWith("/");
		if (!cwd || atFilesCwd !== cwd || !atFiltered.includes(path)) return;
		if (!isDir) {
			const absolute = `${cwd.replace(/[\\/]$/, "")}/${path}`;
			options.editorRef.current?.insertReference(atToken.start, atToken.end, {
				type: "file",
				path: absolute,
				label: path,
			});
			setAtToken(null);
			return;
		}
		options.editorRef.current?.replaceText(atToken.start, atToken.end, `@${path}`);
		setAtToken({ start: atToken.start, end: atToken.start + path.length + 1, query: path });
	};

	/** @ 菜单键盘导航：↑↓ 移动，Enter/Tab 选中，Esc 折叠（保留文本）；消费事件返回 true */
	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
		if (!atOpen || !atToken) return false;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setAtSelected((s) => s + 1);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setAtSelected((s) => s - 1);
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			setAtDismissed(true);
			return true;
		}
		if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
			e.preventDefault();
			const path = atFiltered[Math.min(atSelected, atFiltered.length - 1)];
			if (path) handleAtPick(path);
			return true;
		}
		return false;
	};

	return {
		atToken,
		atOpen,
		atFiltered,
		atSelected,
		setAtSelected,
		setAtDismissed,
		updateToken,
		handleAtPick,
		handleKeyDown,
	};
}
