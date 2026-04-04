import { cn, channelColor } from "@/lib/utils";

type BadgeProps = {
  children: React.ReactNode;
  variant?: "default" | "accent" | "healthy" | "warning" | "error" | "muted";
  className?: string;
};

const variantClasses: Record<string, string> = {
  default: "bg-cream-dark text-ink-muted",
  accent: "bg-accent-bg text-accent",
  healthy: "bg-healthy-bg text-healthy",
  warning: "bg-warning-bg text-warning",
  error: "bg-error-bg text-error",
  muted: "bg-cream-dark text-ink-faint",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium",
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium text-white",
        channelColor(channel),
      )}
    >
      {channel}
    </span>
  );
}

export function StatusDot({ status }: { status: "healthy" | "warning" | "error" }) {
  const colors = {
    healthy: "bg-healthy",
    warning: "bg-warning",
    error: "bg-error",
  };
  return (
    <span className="relative flex h-2.5 w-2.5">
      {status === "healthy" && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-healthy opacity-40" />
      )}
      <span className={cn("relative inline-flex rounded-full h-2.5 w-2.5", colors[status])} />
    </span>
  );
}
