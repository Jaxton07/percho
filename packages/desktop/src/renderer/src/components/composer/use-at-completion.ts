import { type RefObject, useEffect, useState } from "react";
import { getPi } from "../../api";
import { type AtToken, extractAtToken, filterFiles } from "./at-files";

export interface UseAtCompletionOptions {
	cwd: string | null;
	text: string;
	attachments: string[];
	slashOpen: boolean;
	setText: (updater: string | ((prev: string) => string)) => void;
	setAttachments: (updater: string[] | ((prev: string[]) => string[])) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * @ 文件补全域：光标前 @ token 探测 + 项目文件列表拉取（每 cwd 一次）+
 * 选中/续钻 + 胶囊移除回填 + 键盘导航。
 */
export function useAtCompletion(options: UseAtCompletionOptions) {
	const { cwd, text, attachments, slashOpen } = options;
	const [atToken, setAtToken] = useState<AtToken | null>(null);
	const [atFiles, setAtFiles] = useState<string[]>([]);
	const [atFilesCwd, setAtFilesCwd] = useState<string | null>(null);
	const [atSelected, setAtSelected] = useState(0);
	const [atDismissed, setAtDismissed] = useState(false);

	/** @ 菜单：token 仍与当前文本一致才有效（程序化清空文本后自动失效），slash 打开时不竞争 */
	const atOpen =
		atToken !== null &&
		text.slice(atToken.start, atToken.end) === `@${atToken.query}` &&
		!atDismissed &&
		!slashOpen;
	const atFiltered = atOpen && atToken ? filterFiles(atFiles, atToken.query) : [];

	// @ token 出现时拉取项目文件列表（每 cwd 一次，backend TTL 缓存；atToken 击键频变但条件拦截）
	useEffect(() => {
		if (!atToken || !cwd || atFilesCwd === cwd) return;
		let cancelled = false;
		void getPi()
			.listProjectFiles(cwd)
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
		setAtToken(extractAtToken(value, cursor));
	};

	/** 选中文件/目录：文件 → @ 胶囊（token 从文本移除）；目录续钻（菜单保持，query 变为目录路径） */
	const handleAtPick = (path: string) => {
		if (!atToken) return;
		const isDir = path.endsWith("/");
		const before = text.slice(0, atToken.start);
		const after = text.slice(atToken.end);
		if (!isDir) {
			// token 两侧都是空白时收掉一个，避免出现双空格
			const joined = before.endsWith(" ") && after.startsWith(" ") ? before + after.slice(1) : before + after;
			options.setText(joined);
			options.setAttachments((prev) => [...prev, path]);
			setAtToken(null);
			const cursor = before.length;
			requestAnimationFrame(() => {
				const el = options.textareaRef.current;
				if (el) {
					el.focus();
					el.setSelectionRange(cursor, cursor);
				}
			});
			return;
		}
		const insert = `@${path}`;
		options.setText(before + insert + after);
		const cursor = (before + insert).length;
		setAtToken({ start: atToken.start, end: cursor, query: path });
		requestAnimationFrame(() => {
			const el = options.textareaRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(cursor, cursor);
			}
		});
	};

	/** 移除 @ 胶囊：恢复为全路径纯文本（追加到文本末尾，与 slash 胶囊删除恢复同逻辑） */
	const handleAttachmentRemove = (index: number) => {
		const path = attachments[index];
		if (!path) return;
		options.setAttachments((prev) => prev.filter((_, i) => i !== index));
		options.setText((prev) => (prev ? `${prev} @${path} ` : `@${path} `));
		requestAnimationFrame(() => {
			const el = options.textareaRef.current;
			if (el) {
				el.focus();
				const len = el.value.length;
				el.setSelectionRange(len, len);
			}
		});
	};

	/** @ 菜单键盘导航：↑↓ 移动，Enter/Tab 选中，Esc 折叠（保留文本）；消费事件返回 true */
	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
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
		handleAttachmentRemove,
		handleKeyDown,
	};
}
