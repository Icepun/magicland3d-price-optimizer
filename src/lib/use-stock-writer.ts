"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { patchProductsInCache } from "@/lib/products-cache";

type ProductLike = { id: string; stock: number };
/** Ürün detayı cache'i — varyant grubu üyelerinin stoğu BURADA da kopya durur. */
type ProductDetailLike = ProductLike & {
  variantGroup?: { products?: { id: string; stock: number }[] } | null;
};

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

  // Unmount'ta (ör. başka sayfaya geçiş) bekleyen debounce'lu yazmaları İPTAL etme —
  // hemen gönder, yoksa "+ bastım ama kaydolmadı" veri kaybı olur. fetch bileşene bağlı
  // değil, unmount sonrası da tamamlanır.
  const flushRef = useRef<(id: string, stock: number) => void>(() => {});
  useEffect(() => {
    const timersMap = timers.current;
    const pendingMap = pending.current;
    return () => {
      timersMap.forEach((tm, id) => {
        clearTimeout(tm);
        const stock = pendingMap.get(id);
        if (stock !== undefined) flushRef.current(id, stock);
      });
      timersMap.clear();
    };
  }, []);

  const applyOptimistic = useCallback(
    (id: string, stock: number) => {
      qc.setQueryData<ProductLike | undefined>(["product", id], (old) =>
        old ? { ...old, stock } : old
      );
      qc.setQueriesData<ProductLike[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.map((p) => (p.id === id ? { ...p, stock } : p)) : old
      );
      // VARYANT LİSTELERİ: her varyantın detay cache'i, grup KARDEŞLERİNİN stoğunu da kopya tutar.
      // Yalnız ["product", id] güncellenince diğer varyanta geçildiğinde ESKİ stok görünüyordu
      // (ana sayfaya dönmeden düzelmiyordu). Tüm ürün detaylarındaki grup üyesini de yamala.
      qc.setQueriesData<ProductDetailLike | undefined>({ queryKey: ["product"] }, (old) => {
        const members = old?.variantGroup?.products;
        if (!members?.some((p) => p.id === id)) return old;
        return {
          ...old!,
          variantGroup: {
            ...old!.variantGroup!,
            products: members.map((p) => (p.id === id ? { ...p, stock } : p)),
          },
        };
      });
    },
    [qc]
  );

  const flush = useCallback(
    async (id: string, stock: number, attempt = 0): Promise<void> => {
      try {
        const r = await fetch(`/api/products/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stock }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        pending.current.delete(id);
      } catch {
        if (attempt < 2) {
          await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
          return flush(id, stock, attempt + 1);
        }
        pending.current.delete(id);
        toast.error("Stok kaydedilemedi — bağlantı yavaş");
        // Otoritatif değeri geri çek (optimistic değeri düzelt) — SADECE bu ürün (tüm liste değil).
        qc.invalidateQueries({ queryKey: ["product", id] });
        patchProductsInCache(qc, [id]);
      }
    },
    [qc]
  );

  // flushRef'i güncel flush'a bağla — unmount cleanup'ı veri kaybını önlemek için kullanır.
  flushRef.current = flush;

  /** Stok'u MUTLAK değere ayarla (instant UI + arka planda debounce'lu yazma). */
  const setStock = useCallback(
    (id: string, value: number) => {
      const stock = Math.max(0, Math.round(value));
      pending.current.set(id, stock);
      applyOptimistic(id, stock);
      const prev = timers.current.get(id);
      if (prev) clearTimeout(prev);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void flush(id, stock);
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
