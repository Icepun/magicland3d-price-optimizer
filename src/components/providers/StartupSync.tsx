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

    // 2) Otomatik fiyat tazeleme KALDIRILDI — cache-first felsefe: fiyatlar açılışta otomatik
    //    ÇEKİLMEZ. Kullanıcı Ürünler sayfasındaki "Fiyatları Güncelle" butonuna basınca çekilir.
  }, [queryClient]);

  return null;
}
