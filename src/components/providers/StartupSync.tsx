"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Açılış görevleri — HAFİF tutulur.
 *
 * ÖNEMLİ: Otomatik Trendyol/Shopify ürün senkronu BİLEREK kaldırıldı. Eskiden
 * her açılışta full-sync (25 sayfa, ürün başına birkaç DB yazması) tetikleniyordu.
 * Turso embedded replica okumayı local yapar ama YAZMALAR hâlâ buluta (eu-west-1)
 * gider → onlarca ardışık ağ gidiş-dönüşü + 25 Trendyol API çağrısı → açılışta
 * dakikalarca donma. Senkron artık SADECE kullanıcı "Ürünleri Senkronize Et"
 * butonuna bastığında çalışır (öngörülebilir, UI'ı kilitlemez).
 *
 * Kalan tek iş: TEX kargo baremini ilk kez (makine başına bir kez) seed etmek —
 * tek istek, arka planda, UI'ı bloklamaz.
 */
export function StartupSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Makine başına bir kez (session değil) — her açılışta tekrar istek atma
    if (localStorage.getItem("tex-seed-v1") === "done") return;

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
        /* sessiz geç — kritik değil, sonraki açılışta tekrar denenir */
      });
  }, [queryClient]);

  return null;
}
