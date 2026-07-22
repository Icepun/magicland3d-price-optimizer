"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useIsFetching, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { pushPerf, perfBuffer, clearPerf, formatPerfLog, type PerfEvent } from "@/lib/perf-log";

const STORAGE_KEY = "mh-perf";
const CHANGE_EVENT = "mh-perf-change";

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribeEnabled(onChange: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      e.preventDefault();
      writeEnabled(!readEnabled());
    }
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    if (/cdn\.shopify\.com/i.test(u.hostname)) {
      const w = u.searchParams.get("width");
      return "shopify-img" + (w ? `?w=${w}` : " (TAM BOY)");
    }
    return u.pathname.replace(/^\/api\//, "api/") + (u.search ? u.search.slice(0, 36) : "");
  } catch {
    return url.slice(0, 60);
  }
}
function keyLabel(key: readonly unknown[]): string {
  return key.map((k) => (typeof k === "object" ? JSON.stringify(k) : String(k))).join(",").slice(0, 56);
}

/** Performans HUD — Ctrl+Shift+L ile aç/kapa. Kapalıyken hiçbir gözlemci kurulmaz (sıfır yük). */
export function PerfHud() {
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, () => false);

  if (!enabled) return null;
  return (
    <PerfHudPanel
      onClose={() => writeEnabled(false)}
    />
  );
}

function PerfHudPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const inFlight = useIsFetching();
  const mutating = useIsMutating();
  const pathname = usePathname();

  const [stats, setStats] = useState({ fps: 60, longCount: 0, worst: 0 });
  const fpsRef = useRef(60);
  const longRef = useRef({ count: 0, worst: 0 });

  // 1) Uzun görevler = UI'yi >50ms bloke eden işler (donma / kare düşüşü)
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration >= 50) {
            longRef.current.count++;
            longRef.current.worst = Math.max(longRef.current.worst, e.duration);
            pushPerf({ kind: "longtask", label: "UZUN GÖREV — UI bloke", ms: e.duration });
          }
        }
      });
      po.observe({ entryTypes: ["longtask"], buffered: true } as PerformanceObserverInit);
    } catch {}
    return () => po?.disconnect();
  }, []);

  // 2) Ağ kaynakları: /api çağrıları + görseller — süre, boyut, cache mi ağ mı
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          const name = e.name;
          const isApi = name.includes("/api/");
          const isImg =
            e.initiatorType === "img" ||
            /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(name) ||
            /cdn\.shopify\.com/i.test(name);
          if (!isApi && !isImg) continue;
          const cached = e.transferSize === 0 && e.duration < 8;
          pushPerf({
            kind: "fetch",
            label: (isImg ? "🖼 " : "") + shortUrl(name),
            ms: e.duration,
            bytes: e.transferSize,
            detail: cached ? "cache" : undefined,
          });
        }
      });
      po.observe({ entryTypes: ["resource"], buffered: true } as PerformanceObserverInit);
    } catch {}
    return () => po?.disconnect();
  }, []);

  // 3) React Query — arka planda HANGİ sorgu ne kadar sürede fetch'lendi
  useEffect(() => {
    const cache = qc.getQueryCache();
    const starts = new Map<string, number>();
    return cache.subscribe(() => {
      for (const q of cache.getAll()) {
        const h = q.queryHash;
        if (q.state.fetchStatus === "fetching") {
          if (!starts.has(h)) starts.set(h, performance.now());
        } else if (starts.has(h)) {
          const ms = performance.now() - (starts.get(h) as number);
          starts.delete(h);
          pushPerf({ kind: "query", label: keyLabel(q.queryKey), ms, detail: q.state.status });
        }
      }
    });
  }, [qc]);

  // 4) FPS (yalnız panel açıkken)
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let acc = 0;
    const loop = (now: number) => {
      acc += now - last;
      last = now;
      frames++;
      if (acc >= 1000) {
        fpsRef.current = Math.round((frames * 1000) / acc);
        frames = 0;
        acc = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 5) Sayfa geçiş süresi (yeni route → ilk boyama)
  useEffect(() => {
    const t0 = performance.now();
    let r1 = 0;
    let r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        pushPerf({ kind: "nav", label: `→ ${pathname}`, ms: performance.now() - t0 });
      });
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [pathname]);

  // Paneli 400ms'de bir tazele → her olayda re-render edip kendisi jank yapmasın.
  // Ref'leri (gözlemcilerin yazdığı) state'e kopyala ki render sırasında ref OKUMAYALIM.
  useEffect(() => {
    const iv = setInterval(
      () => setStats({ fps: fpsRef.current, longCount: longRef.current.count, worst: longRef.current.worst }),
      400
    );
    return () => clearInterval(iv);
  }, []);

  const recent = perfBuffer().slice(-70).reverse();
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(formatPerfLog()).then(
      () => pushPerf({ kind: "nav", label: "📋 Log panoya kopyalandı — bana yapıştır" }),
      () => {}
    );
  }, []);

  return (
    <div className="fixed bottom-3 right-3 z-[300] w-[440px] max-h-[62vh] flex flex-col rounded-xl border border-border bg-background/95 backdrop-blur shadow-2xl text-[11px] font-mono">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="font-bold text-primary">⚡ Perf</span>
        <span className={stats.fps < 50 ? "text-destructive font-bold" : "text-green-500"}>{stats.fps}fps</span>
        <span className="text-muted-foreground">· {inFlight}↓ {mutating}✎</span>
        <span className={stats.longCount > 0 ? "text-amber-500" : "text-muted-foreground"}>
          · {stats.longCount} donma{stats.worst ? ` (${stats.worst.toFixed(0)}ms)` : ""}
        </span>
        <div className="ml-auto flex gap-1">
          <button onClick={copy} className="px-2 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25">Kopyala</button>
          <button
            onClick={() => {
              clearPerf();
              longRef.current = { count: 0, worst: 0 };
              setStats({ fps: fpsRef.current, longCount: 0, worst: 0 });
            }}
            className="px-2 py-0.5 rounded bg-muted hover:bg-muted/70"
          >
            Temizle
          </button>
          <button onClick={onClose} className="px-2 py-0.5 rounded bg-muted hover:bg-muted/70">✕</button>
        </div>
      </div>
      <div className="overflow-y-auto px-2 py-1 space-y-0.5">
        {recent.length === 0 ? (
          <p className="text-muted-foreground px-1 py-2 leading-relaxed">
            Gezin · maliyet kaydet · kaydır… Olaylar burada akar. Sonra <b>Kopyala</b> → bana yapıştır.
          </p>
        ) : (
          recent.map((e) => <PerfRow key={e.id} e={e} />)
        )}
      </div>
    </div>
  );
}

function PerfRow({ e }: { e: PerfEvent }) {
  const color =
    e.kind === "longtask"
      ? "text-destructive font-bold"
      : e.kind === "nav"
        ? "text-violet-400"
        : e.kind === "query"
          ? "text-sky-400"
          : e.detail === "cache"
            ? "text-green-500"
            : "text-foreground";
  const ms = e.ms != null ? `${e.ms.toFixed(0)}ms` : "";
  const kb = e.bytes != null && e.bytes > 0 ? ` ${(e.bytes / 1024).toFixed(0)}KB` : "";
  return (
    <div className="flex items-baseline gap-2 leading-tight">
      <span className="text-muted-foreground/40 shrink-0">{e.wall.slice(0, 8)}</span>
      <span className={`shrink-0 tabular-nums w-11 text-right ${e.ms != null && e.ms > 200 ? "text-amber-500" : "text-muted-foreground"}`}>{ms}</span>
      <span className={`truncate ${color}`}>
        {e.label}
        {kb}
        {e.detail === "cache" ? " ✓cache" : ""}
      </span>
    </div>
  );
}
