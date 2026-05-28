import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-12 px-4",
        "animate-in fade-in duration-500",
        className
      )}
    >
      <div
        className="rounded-full p-4 mb-4"
        style={{
          background:
            "radial-gradient(circle, oklch(0.62 0.20 278 / 12%) 0%, transparent 70%)",
        }}
      >
        <Icon
          className="h-12 w-12 text-muted-foreground/60"
          strokeWidth={1.4}
        />
      </div>
      <h3 className="text-base font-semibold text-foreground mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground max-w-sm mb-4">
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
