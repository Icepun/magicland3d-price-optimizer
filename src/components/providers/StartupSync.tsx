"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface TrendyolPublicSettings {
  sellerId: string;
  hasApiKey: boolean;
  hasApiSecret: boolean;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `${url} ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

export function StartupSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (sessionStorage.getItem("startup-trendyol-sync") === "done") return;
    sessionStorage.setItem("startup-trendyol-sync", "done");

    let cancelled = false;

    // TEX kargo barem seed (idempotent — bir kez çalışır, AppSetting flag ile)
    fetch("/api/seed/tex-cargo-rules", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (res?.seeded) {
          queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
          toast.success(`TEX kargo bareme yüklendi (${res.added} kural)`);
        }
      })
      .catch(() => {
        /* sessiz geç, kritik değil */
      });

    async function runStartupSync() {
      const settings = await fetchJson<TrendyolPublicSettings>("/api/trendyol/settings");
      if (!settings.sellerId || !settings.hasApiKey || !settings.hasApiSecret) return;

      const result = await fetchJson<{
        created: number;
        updated: number;
        skipped: number;
      }>("/api/trendyol/sync-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approved: true,
          archived: false,
          maxPages: 25,
          size: 100,
        }),
      });

      if (cancelled) return;

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["product-profit"] }),
      ]);

      if (result.created > 0 || result.updated > 0) {
        toast.success(
          `Trendyol sync tamamlandı: ${result.created} yeni, ${result.updated} güncel`
        );
      }
    }

    runStartupSync().catch((error) => {
      if (!cancelled) {
        toast.error(
          error instanceof Error
            ? `Otomatik Trendyol sync başarısız: ${error.message}`
            : "Otomatik Trendyol sync başarısız"
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  return null;
}
