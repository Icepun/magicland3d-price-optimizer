"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Bell, Package, Disc3, Printer, ShoppingCart, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface AppAlert {
  id: string;
  type: "stock" | "filament" | "printer" | "order";
  severity: "critical" | "warning" | "success";
  title: string;
  body: string;
  href: string;
  /** Kalıcı bildirimlerde oluşturulma zamanı (ISO) — OS bildirimi yaş sınırı için. */
  createdAt?: string;
}

const DISMISS_KEY = "mh-dismissed-alerts";
const NOTIFIED_KEY = "mh-notified-alerts";

/**
 * İşletim sistemi bildirimi için yaş sınırı — TÜRE GÖRE.
 *
 * Eskiden tek sınır (6 saat) vardı ve sınırı aşanlar sessizce "bildirildi" işaretleniyordu:
 * gece 23:00'te biten baskı ya da gelen kritik sipariş sabaha kadar bekleyince BİR DAHA hiç
 * duyurulmuyordu. Artık kritik olaylar 3 gün, tamamlanan baskılar 1 gün boyunca duyurulabilir;
 * sınırı aşanlar da yutulmaz, tek bir özet bildirimiyle haber verilir.
 *
 * ⚠️ Aynı politika masaüstü uygulamasının arka planında da var (electron/main.js →
 * OS_AGE_LIMITS). İkisi aynı anda çalışmaz (aşağıdaki masaüstü kontrolü), ama sınırları
 * değiştirirken iki dosyayı birlikte güncelle.
 */
export const OS_AGE_LIMITS = {
  critical: 72 * 60 * 60_000,
  success: 24 * 60 * 60_000,
};
/** Bu sayıdan fazla yeni bildirim birikmişse tek tek değil, tek özet bildirimi gösterilir. */
const OS_BURST_LIMIT = 4;

export interface OsToast {
  title: string;
  body: string;
}
export interface OsToastPlan {
  toasts: OsToast[];
  /** Bu tur değerlendirilmiş (bir daha ele alınmayacak) bildirim kimlikleri. */
  markNotified: string[];
}

/**
 * Hangi bildirimlerin işletim sistemi bildirimi olarak gösterileceğine karar verir.
 * Saf fonksiyon — davranışı testlerle sabitlenir.
 */
export function planOsToasts(
  alerts: AppAlert[],
  notified: Set<string>,
  now: number = Date.now()
): OsToastPlan {
  const candidates = alerts.filter(
    (a) => (a.severity === "critical" || a.severity === "success") && !notified.has(a.id)
  );
  if (candidates.length === 0) return { toasts: [], markNotified: [] };

  const ageLimit = (a: AppAlert) =>
    a.severity === "critical" ? OS_AGE_LIMITS.critical : OS_AGE_LIMITS.success;
  const isFresh = (a: AppAlert) => {
    if (!a.createdAt) return true; // anlık uyarıların zamanı yok → hep taze sayılır
    const at = new Date(a.createdAt).getTime();
    if (!Number.isFinite(at)) return true;
    return now - at < ageLimit(a);
  };

  const fresh = candidates.filter(isFresh);
  const stale = candidates.filter((a) => !isFresh(a));
  const toasts: OsToast[] = [];

  if (fresh.length > OS_BURST_LIMIT) {
    toasts.push({
      title: "Magicland 3D Hub",
      body: `${fresh.length} yeni bildirim — zile göz at`,
    });
  } else {
    for (const a of fresh) {
      toasts.push({ title: `Magicland 3D Hub — ${a.title}`, body: a.body });
    }
  }
  // Yaş sınırını aşanlar sessizce yutulmaz: tek satırlık özet yine gösterilir.
  if (stale.length > 0) {
    toasts.push({
      title: "Magicland 3D Hub",
      body: `${stale.length} bildirim seni bekliyor — zile göz at`,
    });
  }

  return { toasts, markNotified: candidates.map((a) => a.id) };
}

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

/** Masaüstü uygulamasının içinde miyiz? (Orada bildirimleri arka plan gösterir → burada gösterme.) */
function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as unknown as { trendyolPriceOptimizer?: unknown }).trendyolPriceOptimizer);
}

export function NotificationBell() {
  const { data } = useQuery<{ alerts: AppAlert[] }>({
    queryKey: ["notifications"],
    queryFn: () => fetch("/api/notifications").then((r) => r.json()),
    // Bildirimin ekrana düşme süresi doğrudan buna bağlı — üretim gecikmesinin üstüne
    // bir dakika daha binmesin diye kısa tutuldu (uç tarafı bu sıklık için ucuzlatıldı).
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  const alerts = useMemo(() => data?.alerts ?? [], [data?.alerts]);

  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    typeof window === "undefined" ? new Set() : readSet(DISMISS_KEY)
  );

  // Kalıcı (sipariş) bildirimlerini sunucuda da "okundu" işaretle → cihazlar-arası.
  // Anlık (stok/filament/yazıcı) id'ler eşleşmez, zararsız. Sonra listeyi tazele.
  function ackServer(ids: string[]) {
    if (ids.length === 0) return;
    fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
      .then(() => qc.invalidateQueries({ queryKey: ["notifications"] }))
      .catch(() => {/* ignore */});
  }

  // İşletim sistemi bildirimi — İKİNCİ yol.
  // Masaüstü uygulamasında bunu arka plan (electron/main.js) gösterir: pencere kapalı,
  // gizli ya da yeniden yüklenirken de çalışır. Burada tekrar göstermek çift bildirim olurdu.
  // Tarayıcıdan açıldığında ise tek yol burasıdır.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (isDesktopApp()) return;
    const notified = readSet(NOTIFIED_KEY);
    const plan = planOsToasts(alerts, notified);
    if (plan.markNotified.length === 0) return;
    const fire = () => {
      for (const t of plan.toasts) {
        try {
          new Notification(t.title, { body: t.body });
        } catch { /* ignore */ }
      }
    };
    if (plan.toasts.length > 0) {
      if (Notification.permission === "granted") fire();
      else if (Notification.permission !== "denied") {
        Notification.requestPermission().then((p) => p === "granted" && fire());
      }
    }
    plan.markNotified.forEach((id) => notified.add(id));
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
    ackServer([id]);
  }
  function dismissAll() {
    const next = new Set(dismissed);
    visible.forEach((a) => next.add(a.id));
    setDismissed(next);
    writeSet(DISMISS_KEY, next);
    ackServer(visible.map((a) => a.id));
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Bildirimler"
        className="relative p-1.5 rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors active:scale-95"
      >
        <Bell className={cn("h-4 w-4 transition-transform", hasCritical && "animate-pulse")} />
        {count > 0 && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 rounded-full text-[9px] font-bold text-white flex items-center justify-center tabular-nums",
              "animate-in zoom-in-50 duration-200",
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
                visible.map((a, i) => {
                  const Icon =
                    a.type === "filament" ? Disc3 : a.type === "printer" ? Printer : a.type === "order" ? ShoppingCart : Package;
                  return (
                    <div
                      key={a.id}
                      // Liste sırayla akarak gelsin (ilk 8 satır; sonrası anında görünür).
                      style={i < 8 ? { animationDelay: `${i * 35}ms`, animationFillMode: "backwards" } : undefined}
                      className="flex items-start gap-2 px-3 py-2 border-b border-border/40 last:border-0 hover:bg-muted/40 group animate-in fade-in slide-in-from-left-1 duration-200"
                    >
                      <span
                        className={cn(
                          "mt-0.5 shrink-0 h-6 w-6 rounded-md flex items-center justify-center",
                          a.severity === "critical"
                            ? "bg-destructive/15 text-destructive"
                            : a.severity === "success"
                              ? "bg-emerald-500/15 text-emerald-500"
                              : "bg-amber-500/15 text-amber-500"
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
