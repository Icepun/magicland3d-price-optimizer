"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { refreshChangedStocks } from "@/lib/products-cache";

/** Pencereye her dönüşte değil, en fazla bu sıklıkla sorulur (alt-tab'lar arka arkaya gelebiliyor). */
const EN_SIK_MS = 5_000;

/**
 * Ekran açılınca ve pencereye dönülünce DEĞİŞEN stokları çeker (bkz. `refreshChangedStocks`).
 *
 * Ürün listesi bilinçli olarak kendiliğinden yeniden çekilmiyor (kullanıcı isteği: "Yenile
 * demedikçe veri çekme"). Bu kanca o kuralı bozmaz: ağır liste hesabı yerine yalnız son
 * okumadan beri değişen ürünlerin STOĞU gelir — telefondan düşülen stok listeye dönünce görünür.
 *
 * `listeAlindi`: listenin sunucudan alındığı an (React Query `dataUpdatedAt`); yoksa çalışmaz.
 */
export function useFreshStocks(listeAlindi: number | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!listeAlindi) return;
    let son = 0;
    const tazele = () => {
      const simdi = Date.now();
      if (simdi - son < EN_SIK_MS) return;
      son = simdi;
      void refreshChangedStocks(qc, listeAlindi);
    };
    tazele();
    const gorunurOldu = () => {
      if (document.visibilityState === "visible") tazele();
    };
    window.addEventListener("focus", tazele);
    document.addEventListener("visibilitychange", gorunurOldu);
    return () => {
      window.removeEventListener("focus", tazele);
      document.removeEventListener("visibilitychange", gorunurOldu);
    };
  }, [qc, listeAlindi]);
}
