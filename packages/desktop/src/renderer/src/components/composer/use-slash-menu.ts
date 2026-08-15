import type { SlashCommandInfo } from "@percho/shared";
import { type RefObject, useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { isDraftSessionId } from "../../stores/sessions";
import { filterCommands } from "./slash-filter";

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

/** 斜杠菜单域：命令清单拉取 + 胶囊回填 + 键盘导航（↑↓/Tab/Esc） */
export function useSlashMenu(options: UseSlashMenuOptions) {
	const t = useT();
	const [slashSelected, setSlashSelected] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
	/** 点击面板外部后隐藏菜单（保留文本，再次输入时恢复） */
	const [slashDismissed, setSlashDismissed] = useState(false);

	const { activeSessionId, cwd, trustVersion, text } = options;
	/** 输入以 / 开头时打开命令面板；query = 第一个词（/ 后） */
	const slashOpen = text.startsWith("/") && !slashDismissed;
	const slashQuery = slashOpen ? (text.slice(1).split(" ")[0] ?? "") : "";
	/** trim 后是否已带参数（Enter 时决定执行还是选中） */
	const slashHasArgs = slashOpen && text.trim().includes(" ");

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

	/** 菜单选中命令：无参内置立即执行（此时才建真实会话）；带参内置/模板/技能回填胶囊，发送时才建 */
	const handleSlashPick = async (command: SlashCommandInfo) => {
		if (!command.supported) return;
		const inline = new Set(["compact", "settings"]);
		if (command.source === "builtin" && inline.has(command.name)) {
			const sessionId = await options.ensureSession();
			if (!sessionId) {
				options.showFeedback(t("slash.feedback.noSession"), "warn");
				return;
			}
			options.setText("");
			try {
				await options.runSlashCommand(`/${command.name}`, sessionId);
			} catch (err) {
				options.setError(err instanceof Error ? err.message : String(err));
			}
			return;
		}
		// 需参数/模板/skill：确认命令，输入框显示为胶囊，等待 args（draft 不提前转正，发送时 ensureSession）
		options.setSlashCommand(command.name);
		options.setText("");
		setSlashDismissed(true);
		requestAnimationFrame(() => options.textareaRef.current?.focus());
	};

	/** 按下标选中菜单项（无匹配时落回正常发送） */
	const handleSlashPickByIndex = (index: number) => {
		const flat = filterCommands(slashCommands, slashQuery);
		const command = flat[Math.min(index, flat.length - 1)] ?? undefined;
		if (command) {
			void handleSlashPick(command);
		} else {
			void options.handleSend();
		}
	};

	/** Tab 补全：确认选中命令为胶囊（args 留空待输入），菜单随之关闭 */
	const handleSlashTabComplete = () => {
		const flat = filterCommands(slashCommands, slashQuery);
		if (flat.length === 0) return;
		const command = flat[Math.min(slashSelected, flat.length - 1)] ?? flat[0];
		if (!command) return;
		options.setSlashCommand(command.name);
		options.setText("");
		setSlashSelected(0);
		setSlashDismissed(false);
		requestAnimationFrame(() => options.textareaRef.current?.focus());
	};

	/** 空文本时把 slash 胶囊弹回文本（Backspace/Delete/Esc；@ 胶囊优先级更高，由调用方先判） */
	const restoreSlashPill = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		e.preventDefault();
		options.setSlashCommand(null);
		options.setText(`/${options.slashCommand} `);
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

	/** 斜杠菜单键盘导航；消费事件返回 true（Enter 的发送/选中语义也在此） */
	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
		// Tab 补全选中命令（已有参数时让位默认行为）
		if (slashOpen && !slashHasArgs && e.key === "Tab") {
			e.preventDefault();
			handleSlashTabComplete();
			return true;
		}
		if (slashOpen && e.key !== "Enter") {
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
				options.setText("");
				return true;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && slashOpen) {
			e.preventDefault();
			// 已带参数 → 直接发送（命令分发或模板透传）；否则选中的命令执行/回填
			if (slashHasArgs) {
				void options.handleSend();
			} else {
				handleSlashPickByIndex(slashSelected);
			}
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
		slashHasArgs,
		slashDismissed,
		setSlashDismissed,
		handleSlashPick,
		handleSlashPickByIndex,
		restoreSlashPill,
		handleKeyDown,
	};
}
