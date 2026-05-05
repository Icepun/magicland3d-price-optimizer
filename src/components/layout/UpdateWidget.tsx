"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type UpdaterState = NonNullable<
  NonNullable<Window["trendyolPriceOptimizer"]>["updater"]
> extends {
  getStatus: () => Promise<infer T>;
}
  ? T
  : never;

const initialState: UpdaterState = {
  status: "idle",
  message: "Guncelleme kontrolu hazir",
  version: "",
  percent: 0,
};

export function UpdateWidget() {
  const [state, setState] = useState<UpdaterState>(initialState);
  const [busy, setBusy] = useState(false);

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
    const unsubscribe = updater.onStatus(setState);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [updater]);

  if (!updater) return null;

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
    <div className="border-t p-3">
      <div className="mb-2 text-xs text-sidebar-foreground/70">
        <div className="font-medium text-sidebar-foreground">Surum {state.version || "-"}</div>
        <div className="truncate">{state.message}</div>
      </div>

      {isDownloading && (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-sidebar-accent">
          <div
            className="h-full bg-sidebar-primary transition-all"
            style={{ width: `${state.percent ?? 0}%` }}
          />
        </div>
      )}

      {canCheck && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full gap-2"
          disabled={busy}
          onClick={() => run(() => updater.checkForUpdates())}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Guncelleme Kontrol
        </Button>
      )}

      {canDownload && (
        <Button
          size="sm"
          className="h-8 w-full gap-2"
          disabled={busy}
          onClick={() => run(() => updater.downloadUpdate())}
        >
          <Download className="h-3.5 w-3.5" />
          Guncellemeyi Indir
        </Button>
      )}

      {canInstall && (
        <Button
          size="sm"
          className="h-8 w-full gap-2"
          onClick={() => updater.quitAndInstall()}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Kur ve Yeniden Baslat
        </Button>
      )}
    </div>
  );
}
