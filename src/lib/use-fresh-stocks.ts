"use client";

import { gizlilikAbone, pencereGizliMi } from "./pencere-gorunur";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { refreshChangedStocks } from "@/lib/products-cache";

/** Pencereye her dönüşte değil, en fazla bu sıklıkla sorulur (alt-tab'lar arka arkaya gelebiliyor). */
const EN_SIK_MS = 5_000;

/**
 * Ekran açılınca, yeni bir liste gelince ve pencereye dönülünce DEĞİŞEN stokları çeker
 * (bkz. `refreshChangedStocks`).
 *
 * Ürün listesi bilinçli olarak kendiliğinden yeniden çekilmiyor (kullanıcı isteği: "Yenile
 * demedikçe veri çekme"). Bu kanca o kuralı bozmaz: ağır liste hesabı yerine yalnız son
 * okumadan beri değişen ürünlerin STOĞU gelir — telefondan düşülen stok listeye dönünce görünür.
 *
 * - `baslangic`: stokların hangi andan sonrası sorulacak (listenin hesaplandığı / alındığı an).
 * - `yeniListe`: YALNIZ tam liste çekilince değişen değer (gövdenin hesaplandığı an).
 *
 * ⚠️ Kanca `dataUpdatedAt`'e BAĞLANMAZ: her stok yaması o değeri değiştiriyor, kanca yeniden
 * kuruluyor, 5 sn sınırı sıfırlanıp hemen yeni istek gidiyordu — son yazımdan sonra ~15 sn
 * boyunca arka arkaya istek (Ürünler denetimi, 23 Kas 2026). Başlangıç bir ref'te güncel tutulur.
 */
export function useFreshStocks(baslangic: number | undefined, yeniListe?: number): void {
  const qc = useQueryClient();
  const baslangicRef = useRef(baslangic);
  useEffect(() => {
    baslangicRef.current = baslangic;
  }, [baslangic]);
  const hazir = !!baslangic;
  useEffect(() => {
    if (!hazir) return;
    let son = 0;
    const tazele = () => {
      const simdi = Date.now();
      const bas = baslangicRef.current;
      if (!bas || simdi - son < EN_SIK_MS) return;
      son = simdi;
      void refreshChangedStocks(qc, bas);
    };
    tazele();
    const gorunurOldu = () => {
      if (!pencereGizliMi()) tazele();
    };
    window.addEventListener("focus", tazele);
    const aboneligiBirak = gizlilikAbone(gorunurOldu);
    return () => {
      window.removeEventListener("focus", tazele);
      aboneligiBirak();
    };
  }, [qc, hazir, yeniListe]);
}
