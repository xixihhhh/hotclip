/**
 * 统一控件三件套:Switch(布尔开关)/ Segmented(多档选择)/ ToggleChip(带
 * 图标的开关胶囊)。此前三种开关视觉语言并存(自绘 pill / chip 边框高亮 /
 * 单选圆点),这里收敛成一份——布尔用 Switch,多档用 Segmented,别再让
 * 循环点击的 chip 伪装成开关。
 */
import { createPortal } from "react-dom";
import { useEffect } from "react";

/** 布尔开关(品牌渐变 = 开)。 */
export function Switch({ on, disabled, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors disabled:opacity-35 ${on ? "flame-gradient" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all ${on ? "left-4" : "left-0.5"}`} />
    </button>
  );
}

/** 一行开关:左标签(可带说明)右 Switch。 */
export function SwitchRow({
  label,
  hint,
  on,
  disabled,
  disabledHint,
  onToggle,
}: {
  label: string;
  hint?: string;
  on: boolean;
  disabled?: boolean;
  /** 置灰原因(为什么现在开不了)。 */
  disabledHint?: string;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div className={`flex min-h-7.5 items-center gap-2.5 ${disabled ? "opacity-55" : ""}`} title={disabled ? disabledHint : hint}>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90">
        {label}
        {hint && <span className="ml-2 text-[10.5px] text-mut/70">{disabled && disabledHint ? disabledHint : hint}</span>}
      </span>
      <Switch on={on} disabled={disabled} onToggle={onToggle} />
    </div>
  );
}

/** 多档分段控件(替代「点击循环切换」——档位一眼可见,不用点着数)。 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex max-w-full shrink-0 flex-wrap overflow-hidden rounded-lg border border-line ${disabled ? "opacity-40" : ""}`}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors ${
            o.value === value ? "bg-ember/15 text-ember" : "text-mut hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 小节标题(工作台面板里的分组眉头)。 */
export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-[10.5px] font-bold tracking-[1.5px] text-mut/70">{children}</div>;
}

/**
 * 模态外壳:portal 到 body + Esc 关闭 + 点遮罩关闭。
 * portal 解决了 rise-in transform 让 fixed 定位失效的那类 containing-block
 * 坑(不再依赖祖先链干净);Esc 从「只有审阅台有」变成人人都有。
 */
export function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div data-hotclip-modal="true" onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      {children}
    </div>,
    document.body
  );
}
