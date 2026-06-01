"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, RotateCcw, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type UpdaterState = NonNullable<
  NonNullable<Window["trendyolPriceOptimizer"]>["updater"]
> extends {
  getStatus: () => Promise<infer T>;
}
  ? T
  : never;

const initialState: UpdaterState = {
  status: "idle",
  message: "Güncelleme kontrolü hazır",
  version: "",
  percent: 0,
};

function fmtMB(bytes?: number): string {
  if (!bytes) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtSpeed(bps?: number): string {
  if (!bps) return "—";
  const mbps = bps / 1024 / 1024;
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

export function UpdateWidget() {
  const [state, setState] = useState<UpdaterState>(initialState);
  const [busy, setBusy] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);
  // SSR ve ilk client render'da `false` → sunucu çıktısıyla (null) birebir aynı.
  // Böylece Electron'da preload `window.trendyolPriceOptimizer` enjekte etse bile
  // ilk render'da widget çizilmez → hydration mismatch (React #418, boş ekran) olmaz.
  // mounted=true olunca (sadece client'ta) widget belirir.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const updater = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    return window.trendyolPriceOptimizer?.updater;
  }, []);

  useEffect(() => {
    if (!updater) return;

    let cancelled = false;
    updater.getStatus().then((nextState) => {
      if (!cancelled) setState(nextState);
    });
    updater.getLogPath?.().then((p: string) => {
      if (!cancelled && p) setLogPath(p);
    });
    const unsubscribe = updater.onStatus(setState);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [updater]);

  if (!mounted || !updater) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const canCheck = ["idle", "not-available", "error"].includes(state.status);
  const canDownload = state.status === "available";
  const canInstall = state.status === "downloaded";
  const isDownloading = state.status === "downloading";

  return (
    <div
      className="p-3 shrink-0"
      style={{ borderTop: "1px solid oklch(1 0 0 / 6%)" }}
    >
      <div className="mb-2.5">
        <div className="flex items-center gap-2 mb-0.5">
          <div
            className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              isDownloading
                ? "bg-primary animate-pulse"
                : state.status === "available"
                  ? "bg-amber-400"
                  : state.status === "downloaded"
                    ? "bg-green-400"
                    : state.status === "error"
                      ? "bg-destructive"
                      : "bg-green-500/60"
            )}
          />
          <span className="text-xs font-semibold text-sidebar-foreground">
            Sürüm {state.version || "—"}
          </span>
        </div>
        <div className="text-[11px] text-sidebar-foreground/65 pl-3.5 break-all leading-relaxed">
          {state.message}
        </div>
        {state.status === "error" && logPath && (
          <div className="pl-3.5 mt-1 flex items-center gap-1">
            <FileText className="h-3 w-3 shrink-0 text-sidebar-foreground/45" />
            <span
              className="text-[10px] text-sidebar-foreground/45 break-all cursor-pointer hover:text-sidebar-foreground/65 transition-colors"
              title="Kopyalamak için tıkla"
              onClick={() => navigator.clipboard?.writeText(logPath)}
            >
              {logPath}
            </span>
          </div>
        )}
      </div>

      {isDownloading && (
        <div className="mb-2.5 space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-border">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${state.percent ?? 0}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-sidebar-foreground/55 tabular-nums">
            <span>
              {fmtMB(state.transferred)} / {fmtMB(state.total)} · %{state.percent ?? 0}
            </span>
            <span>{fmtSpeed(state.bytesPerSecond)}</span>
          </div>
        </div>
      )}

      {canCheck && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full gap-2 text-xs"
          disabled={busy}
          onClick={() => run(() => updater.checkForUpdates())}
        >
          <RefreshCw className="h-3 w-3" />
          Güncelleme Kontrol Et
        </Button>
      )}

      {canDownload && (
        <Button
          size="sm"
          className="h-7 w-full gap-2 text-xs"
          disabled={busy}
          onClick={() => run(() => updater.downloadUpdate())}
        >
          <Download className="h-3 w-3" />
          Güncellemeyi İndir
        </Button>
      )}

      {canInstall && (
        <Button
          size="sm"
          className="h-7 w-full gap-2 text-xs"
          onClick={() => updater.quitAndInstall()}
        >
          <RotateCcw className="h-3 w-3" />
          Kur ve Yeniden Başlat
        </Button>
      )}
    </div>
  );
}
