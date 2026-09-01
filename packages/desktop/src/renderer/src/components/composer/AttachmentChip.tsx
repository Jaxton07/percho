import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { CloseIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

/**
 * @ 文件引用胶囊：无边框纯白悬浮（surface 底 + 阴影），蓝色文字保留文件引用语义；
 * 路径超长时 RTL 截断（优先保留文件名端），× 移除并恢复全路径纯文本。
 * 仅截断时挂 Tooltip 显示全路径（未截断内容与胶囊重复，不显示）。
 * 由父级 key={path} 保证换路径即重挂载；RO 覆盖窗口缩放引起的截断变化。
 */
export function AttachmentChip({ path, onRemove }: { path: string; onRemove: () => void }) {
	const t = useT();
	const pathRef = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);

	useEffect(() => {
		const el = pathRef.current;
		if (!el) return;
		const check = () => setTruncated(el.scrollWidth > el.clientWidth);
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const chip = (
		<span className="mt-0.5 flex max-w-[150px] select-none items-center gap-1 rounded-md bg-surface px-2 py-0.5 font-mono text-[12px] leading-5 text-blue-700 shadow-pop dark:text-blue-300">
			<span aria-hidden="true">@</span>
			<span ref={pathRef} className="min-w-0 truncate" style={{ direction: "rtl", textAlign: "left" }}>
				{path}
			</span>
			<button
				type="button"
				aria-label={t("composer.removeAttachment")}
				onClick={onRemove}
				className="shrink-0 text-blue-400 transition-colors hover:text-blue-600 dark:hover:text-blue-200"
			>
				<CloseIcon size={8} />
			</button>
		</span>
	);
	return truncated ? <Tooltip label={path}>{chip}</Tooltip> : chip;
}
