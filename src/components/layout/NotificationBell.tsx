"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Bell, Package, Disc3, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface AppAlert {
  id: string;
  type: "stock" | "filament";
  severity: "critical" | "warning";
  title: string;
  body: string;
  href: string;
}

const DISMISS_KEY = "mh-dismissed-alerts";
const NOTIFIED_KEY = "mh-notified-alerts";

function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}
function writeSet(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function NotificationBell() {
  const { data } = useQuery<{ alerts: AppAlert[] }>({
    queryKey: ["notifications"],
    queryFn: () => fetch("/api/notifications").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const alerts = data?.alerts ?? [];

  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => setDismissed(readSet(DISMISS_KEY)), []);

  // Yeni kritik uyarılar için masaüstü (Electron) bildirimi — bir kez
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const notified = readSet(NOTIFIED_KEY);
    const fresh = alerts.filter((a) => a.severity === "critical" && !notified.has(a.id));
    if (fresh.length === 0) return;
    const fire = () =>
      fresh.forEach((a) => {
        try {
          new Notification(`Magicland 3D Hub — ${a.title}`, { body: a.body });
        } catch {
          /* ignore */
        }
      });
    if (Notification.permission === "granted") fire();
    else if (Notification.permission !== "denied") Notification.requestPermission().then((p) => p === "granted" && fire());
    fresh.forEach((a) => notified.add(a.id));
    writeSet(NOTIFIED_KEY, notified);
  }, [alerts]);

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  const count = visible.length;
  const hasCritical = visible.some((a) => a.severity === "critical");

  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    writeSet(DISMISS_KEY, next);
  }
  function dismissAll() {
    const next = new Set(dismissed);
    visible.forEach((a) => next.add(a.id));
    setDismissed(next);
    writeSet(DISMISS_KEY, next);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Bildirimler"
        className="relative p-1.5 rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 rounded-full text-[9px] font-bold text-white flex items-center justify-center tabular-nums",
              hasCritical ? "bg-destructive" : "bg-amber-500"
            )}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-2 left-0 z-50 w-72 rounded-xl border bg-popover text-popover-foreground shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
              <span className="text-xs font-semibold">Bildirimler {count > 0 && `(${count})`}</span>
              {count > 0 && (
                <button onClick={dismissAll} className="text-[11px] text-primary inline-flex items-center gap-1 hover:underline">
                  <Check className="h-3 w-3" /> Tümünü okundu
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {visible.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">Yeni bildirim yok 🎉</p>
              ) : (
                visible.map((a) => {
                  const Icon = a.type === "filament" ? Disc3 : Package;
                  return (
                    <div key={a.id} className="flex items-start gap-2 px-3 py-2 border-b border-border/40 last:border-0 hover:bg-muted/40 group">
                      <span
                        className={cn(
                          "mt-0.5 shrink-0 h-6 w-6 rounded-md flex items-center justify-center",
                          a.severity === "critical" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-500"
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <Link href={a.href} onClick={() => setOpen(false)} className="min-w-0 flex-1">
                        <p className="text-xs font-medium leading-tight">{a.title}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{a.body}</p>
                      </Link>
                      <button
                        onClick={() => dismiss(a.id)}
                        className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Okundu"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
