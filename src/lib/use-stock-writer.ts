"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { markStockWritePending, patchProductsInCache, patchStocksInCache } from "@/lib/products-cache";

/**
 * Optimistic stok yazıcı (masaüstü).
 *
 * Sorun: stok yazması senkron olarak Turso primary'ye (eu-west-1) gidiyordu; UI
 * yazma bitene kadar bekliyor (buton disabled) + sonra TÜM ürün listesini refetch
 * ediyordu. Bağlantı ara sıra saniyelere sıçradığı için (tail) "3-4 sn + bazen olmuyor".
 *
 * Çözüm:
 *  - UI ANINDA güncellenir (react-query cache'i optimistic set edilir; kullanıcı beklemez).
 *  - Gerçek yazma ARKA PLANDA + debounce'lu (450ms): hızlı +/- tıklamaları TEK yazmaya iner.
 *  - Tail/timeout'a karşı retry (2 tekrar, kısa backoff); kalıcı hatada toast + otoritatif
 *    değeri geri çek (rollback).
 *  - Başarıda refetch YOK → optimistic değer kalır; ağır liste refetch'i ortadan kalkar.
 *
 * Hem ürün listesi (`["products", ...]`) hem ürün detayı (`["product", id]`) cache'lerini
 * günceller, böylece iki ekran da tutarlı kalır.
 */
export function useStockWriter() {
  const qc = useQueryClient();
  const pending = useRef<Map<string, number>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  // Unmount'ta (ör. başka sayfaya geçiş) bekleyen debounce'lu yazmaları İPTAL etme —
  // hemen gönder, yoksa "+ bastım ama kaydolmadı" veri kaybı olur. fetch bileşene bağlı
  // değil, unmount sonrası da tamamlanır.
  const flushRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    const timersMap = timers.current;
    const pendingMap = pending.current;
    return () => {
      timersMap.forEach((tm, id) => {
        clearTimeout(tm);
        if (pendingMap.has(id)) flushRef.current(id);
      });
      timersMap.clear();
    };
  }, []);

  const applyOptimistic = useCallback(
    (id: string, stock: number) => {
      // Liste, ürün detayı ve VARYANT kardeşlerinin detay kopyaları tek yerde yamalanır
      // (bkz. patchStocksInCache). Varyant kopyası atlanınca diğer varyanta geçildiğinde ESKİ
      // stok görünüyordu.
      patchStocksInCache(qc, [{ id, stock }]);
    },
    [qc]
  );

  const flush = useCallback(
    async (id: string): Promise<void> => {
      // Aynı ürün için tek yazıcı çalışsın. Önceki istek sürerken kullanıcı stoğu yeniden
      // değiştirirse eski retry'nin yeni değerin üstüne yazmasını bu sıra engeller.
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      let failed = false;
      try {
        while (pending.current.has(id)) {
          const stock = pending.current.get(id) as number;
          let saved = false;

          for (let attempt = 0; attempt < 3; attempt += 1) {
            // Beklerken daha yeni bir değer geldiyse eski değeri retry etme; dış döngü
            // doğrudan en güncel değeri yazacak.
            if (pending.current.get(id) !== stock) break;
            try {
              const r = await fetch(`/api/products/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ stock }),
              });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              saved = true;
              break;
            } catch {
              if (attempt < 2) {
                await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
              }
            }
          }

          // İstek sürerken değer değiştiyse, başarılı eski yazımdan sonra bile en güncel
          // değer mutlaka son yazım olur.
          if (pending.current.get(id) !== stock) continue;
          pending.current.delete(id);
          if (saved) continue;

          failed = true;
          break;
        }
      } finally {
        inFlight.current.delete(id);
        // Yazım bitti → uzaktan gelen stok tazelemesi artık bu ürünü güncelleyebilir.
        if (!pending.current.has(id)) markStockWritePending(id, false);
      }

      if (failed) {
        toast.error("Stok kaydedilemedi — bağlantı yavaş");
        // Otoritatif değeri geri çek (optimistic değeri düzelt) — SADECE bu ürün (tüm liste değil).
        qc.invalidateQueries({ queryKey: ["product", id] });
        patchProductsInCache(qc, [id]);
      }
    },
    [qc]
  );

  // flushRef'i güncel flush'a bağla — unmount cleanup'ı veri kaybını önlemek için kullanır.
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  /** Stok'u MUTLAK değere ayarla (instant UI + arka planda debounce'lu yazma). */
  const setStock = useCallback(
    (id: string, value: number) => {
      const stock = Math.max(0, Math.round(value));
      pending.current.set(id, stock);
      markStockWritePending(id, true);
      applyOptimistic(id, stock);
      const prev = timers.current.get(id);
      if (prev) clearTimeout(prev);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void flush(id);
        }, 450)
      );
    },
    [applyOptimistic, flush]
  );

  /**
   * Stok'a delta uygula (+1/-1). Hızlı tıklamada render gecikse bile doğru olsun diye
   * bekleyen optimistic değer üzerinden hesaplar; yoksa `current` (render'daki) değeri baz alır.
   */
  const adjustStock = useCallback(
    (id: string, delta: number, current: number) => {
      const base = pending.current.has(id) ? (pending.current.get(id) as number) : current;
      setStock(id, base + delta);
    },
    [setStock]
  );

  return { setStock, adjustStock };
}
