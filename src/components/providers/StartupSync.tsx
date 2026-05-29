"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Açılış görevleri — HEPSİ HAFİF & NON-BLOCKING. UI zaten yerel replica'dan anında
 * dolduğu için bunlar arka planda çalışır, hiçbir şeyi bloklamaz.
 *
 * 1) TEX kargo baremi seed — makine başına bir kez.
 * 2) Fiyat tazeleme — oturum başına bir kez, konfigüre platformlarda "refresh-prices"
 *    modunu çağırır (diff bazlı: sadece DEĞİŞEN fiyatı yazar → yazma ~0). Ürün
 *    EKLEMEZ/SİLMEZ; yeni ürün ekleme ayrı manuel buton.
 *
 * Not: Eski "her açılışta full Trendyol sync" kaldırılmıştı (donma sebebiydi).
 */
export function StartupSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // 1) TEX kargo barem seed — makine başına bir kez
    if (localStorage.getItem("tex-seed-v1") !== "done") {
      fetch("/api/seed/tex-cargo-rules", { method: "POST" })
        .then((r) => r.json())
        .then((res) => {
          localStorage.setItem("tex-seed-v1", "done");
          if (res?.seeded) {
            queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
            toast.success(`TEX kargo bareme yüklendi (${res.added} kural)`);
          }
        })
        .catch(() => {
          /* sessiz */
        });
    }

    // 2) Arka planda fiyat tazeleme — oturum başına bir kez
    if (sessionStorage.getItem("startup-price-refresh") === "done") return;
    sessionStorage.setItem("startup-price-refresh", "done");

    let cancelled = false;

    (async () => {
      let integrations: { shopify?: boolean; trendyol?: boolean } = {};
      try {
        integrations = await fetch("/api/integrations/status").then((r) => r.json());
      } catch {
        return;
      }
      if (cancelled) return;

      const refresh = (platform: "shopify" | "trendyol") =>
        fetch(`/api/${platform}/sync-products`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "refresh-prices" }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);

      const jobs: Array<Promise<{ changed?: number } | null>> = [];
      if (integrations.shopify) jobs.push(refresh("shopify"));
      if (integrations.trendyol) jobs.push(refresh("trendyol"));
      if (jobs.length === 0) return;

      const results = await Promise.all(jobs);
      if (cancelled) return;

      const totalChanged = results.reduce(
        (sum, r) => sum + (r?.changed ?? 0),
        0
      );

      // Yalnızca fiyat gerçekten değiştiyse listeyi tazele (gereksiz refetch yok)
      if (totalChanged > 0) {
        queryClient.invalidateQueries({ queryKey: ["products"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        toast.success(`Fiyatlar güncellendi: ${totalChanged} değişiklik`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  return null;
}
