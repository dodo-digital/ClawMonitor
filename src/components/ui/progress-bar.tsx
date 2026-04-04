import { cn, percentColor } from "@/lib/utils";

type ProgressBarProps = {
  value: number;
  max?: number;
  className?: string;
  barClassName?: string;
  showLabel?: boolean;
  size?: "sm" | "md";
};

export function ProgressBar({
  value,
  max = 100,
  className,
  barClassName,
  showLabel,
  size = "md",
}: ProgressBarProps) {
  const pct = Math.min(100, (value / max) * 100);
  const heightClass = size === "sm" ? "h-1.5" : "h-2.5";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className={cn("flex-1 rounded-full bg-cream-dark overflow-hidden", heightClass)}>
        <div
          className={cn("h-full rounded-full transition-all duration-500", barClassName ?? percentColor(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs text-ink-muted font-medium tabular-nums">{Math.round(pct)}%</span>
      )}
    </div>
  );
}
