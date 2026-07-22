"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { useIsClient } from "@/lib/client-state";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useIsClient();

  const isDark = mounted ? resolvedTheme === "dark" : true;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Açık temaya geç" : "Koyu temaya geç"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "relative inline-flex h-7 items-center gap-0 rounded-full p-0.5 transition-colors",
        "bg-sidebar-accent/40 hover:bg-sidebar-accent/60",
        "border border-sidebar-border",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-6 w-6 rounded-full transition-transform duration-300",
          "bg-sidebar-foreground/15 shadow-sm",
          isDark && "translate-x-6"
        )}
      />
      <span className="relative z-10 inline-flex h-6 w-6 items-center justify-center">
        <Sun
          className={cn(
            "h-3.5 w-3.5 transition-colors",
            isDark ? "text-sidebar-foreground/40" : "text-amber-400"
          )}
        />
      </span>
      <span className="relative z-10 inline-flex h-6 w-6 items-center justify-center">
        <Moon
          className={cn(
            "h-3.5 w-3.5 transition-colors",
            isDark ? "text-primary" : "text-sidebar-foreground/40"
          )}
        />
      </span>
    </button>
  );
}
