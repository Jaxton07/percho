import type { SlashCommandInfo } from "@percho/shared";
import { type RefObject, useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { isDraftSessionId } from "../../stores/sessions";
import { extractSlashToken, filterCommands, removeSlashToken, type SlashToken } from "./slash-filter";

export interface UseSlashMenuOptions {
	activeSessionId: string | null;
	cwd: string | null;
	/** 信任决策应答后递增：按新决策（信任与否）重拉命令 */
	trustVersion: number;
	text: string;
	slashCommand: string | null;
	setText: (updater: string | ((prev: string) => string)) => void;
	setSlashCommand: (command: string | null) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	ensureSession: () => Promise<string | null>;
	runSlashCommand: (content: string, sessionId: string) => Promise<boolean>;
	handleSend: () => Promise<void>;
	showFeedback: (message: string, tone?: "info" | "warn") => void;
	setError: (error: string | null) => void;
}

/**
 * 斜杠菜单域：命令清单拉取 + 光标前 token 探测 + 胶囊回填 + 键盘导航（↑↓/Tab/Esc）。
 * 触发不限于文本开头：/ 在行首或空白后（空格+/）即弹菜单；确认后命令转胶囊，
 * 触发 token 从文本原地移除、其余文字保留（成为命令参数），不再清空输入框。
 */
export function useSlashMenu(options: UseSlashMenuOptions) {
	const t = useT();
	const [slashSelected, setSlashSelected] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
	/** 点击面板外部后隐藏菜单（保留文本，再次输入时恢复） */
	const [slashDismissed, setSlashDismissed] = useState(false);
	/** 光标前 / token（Composer 在 onChange/onSelect 时喂入） */
	const [slashToken, setSlashToken] = useState<SlashToken | null>(null);

	const { activeSessionId, cwd, trustVersion, text } = options;
	/** 胶囊已存在时不再探测（发送拼装只支持单命令，args 里打 / 不开菜单） */
	const updateToken = (value: string, cursor: number) => {
		setSlashToken(options.slashCommand ? null : extractSlashToken(value, cursor));
	};

	/** token 与当前文本一致才有效（程序化改文本自动失效）；胶囊模式下不生效 */
	const slashOpen =
		slashToken !== null &&
		!options.slashCommand &&
		text.slice(slashToken.start, slashToken.end) === `/${slashToken.query}` &&
		!slashDismissed;
	const slashQuery = slashOpen ? slashToken.query : "";

	// 会话切换时重新拉取命令列表（模板/skill 随项目变化）；draft 无后端会话，按 cwd 拉
	// （三类命令只依赖资源加载器；项目信任已在选目录时经 ensureProjectTrust 决策落盘，
	// 应答后 trustVersion 递增触发重拉，把项目级资源补进菜单）
	// biome-ignore lint/correctness/useExhaustiveDependencies: trustVersion 是刻意的触发依赖（信任应答后重拉），effect 体内不引用
	useEffect(() => {
		if (!activeSessionId) {
			setSlashCommands([]);
			return;
		}
		const request = isDraftSessionId(activeSessionId)
			? cwd
				? getPi().listSlashCommandsForCwd(cwd)
				: null
			: getPi().listSlashCommands(activeSessionId);
		if (!request) {
			setSlashCommands([]);
			return;
		}
		let cancelled = false;
		void request
			.then((list) => {
				if (!cancelled) setSlashCommands(list);
			})
			.catch(() => {
				if (!cancelled) setSlashCommands([]);
			});
		return () => {
			cancelled = true;
		};
	}, [activeSessionId, cwd, trustVersion]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 查询词变化时重置选中项
	useEffect(() => {
		setSlashSelected(0);
	}, [slashQuery]);

	/**
	 * 确认选中命令。
	 * - 整条文本恰为无参内置命令（compact/settings）→ 立即执行（选完即跑，现状行为）
	 * - 其余 → 命令转胶囊：触发 token 原地移除，其余文字保留（= 命令参数），发送时拼 /cmd args
	 */
	const confirmCommand = async (command: SlashCommandInfo, { allowInline = true } = {}) => {
		if (!command.supported) return;
		const token = slashToken;
		const standaloneInline =
			allowInline &&
			token !== null &&
			token.start === 0 &&
			text.slice(token.end).trim() === "" &&
			command.source === "builtin" &&
			new Set(["compact", "settings"]).has(command.name);
		if (standaloneInline) {
			const sessionId = await options.ensureSession();
			if (!sessionId) {
				options.showFeedback(t("slash.feedback.noSession"), "warn");
				return;
			}
			options.setText("");
			setSlashToken(null);
			try {
				await options.runSlashCommand(`/${command.name}`, sessionId);
			} catch (err) {
				options.setError(err instanceof Error ? err.message : String(err));
			}
			return;
		}
		options.setSlashCommand(command.name);
		setSlashToken(null);
		if (token) options.setText(removeSlashToken(text, token));
		setSlashDismissed(true);
		requestAnimationFrame(() => {
			const el = options.textareaRef.current;
			if (el) {
				el.focus();
				const len = el.value.length;
				el.setSelectionRange(len, len);
			}
		});
	};

	/** 按下标选中菜单项（无匹配时落回正常发送） */
	const handleSlashPickByIndex = (index: number) => {
		const flat = filterCommands(slashCommands, slashQuery);
		const command = flat[Math.min(index, flat.length - 1)] ?? undefined;
		if (command) {
			void confirmCommand(command);
		} else {
			void options.handleSend();
		}
	};

	/** Tab 补全：确认选中命令为胶囊（不触发内置立即执行），菜单随之关闭 */
	const handleSlashTabComplete = () => {
		const flat = filterCommands(slashCommands, slashQuery);
		const command = flat[Math.min(slashSelected, flat.length - 1)] ?? flat[0];
		if (!command) return;
		void confirmCommand(command, { allowInline: false });
	};

	/** 胶囊弹回文本（空文本 Backspace/Delete，或 Esc）：命令以 "/cmd " 拼回开头，等待继续编辑 */
	const restoreSlashPill = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		e.preventDefault();
		const cmd = options.slashCommand;
		options.setSlashCommand(null);
		options.setText((prev) => (cmd ? (prev ? `/${cmd} ${prev}` : `/${cmd} `) : prev));
		setSlashToken(null);
		setSlashDismissed(true);
		requestAnimationFrame(() => {
			const el = options.textareaRef.current;
			if (el) {
				el.focus();
				const len = el.value.length;
				el.setSelectionRange(len, len);
			}
		});
	};

	/** 斜杠菜单键盘导航；消费事件返回 true（菜单开 = token 有效 = 无参数，Enter/Tab 均为确认选中） */
	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!slashOpen) return false;
		if (e.key === "Tab") {
			e.preventDefault();
			handleSlashTabComplete();
			return true;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSlashSelected((s) => s + 1);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSlashSelected((s) => s - 1);
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			setSlashDismissed(true);
			return true;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			handleSlashPickByIndex(slashSelected);
			return true;
		}
		return false;
	};

	return {
		slashCommands,
		slashSelected,
		setSlashSelected,
		slashOpen,
		slashQuery,
		slashDismissed,
		setSlashDismissed,
		updateToken,
		handleSlashPick: (command: SlashCommandInfo) => confirmCommand(command),
		handleSlashPickByIndex,
		restoreSlashPill,
		handleKeyDown,
	};
}
