"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { UNKNOWN_DASH } from "@/lib/format";

/** Pencere görünürlüğünü dinle — `document.hidden` değişince bileşen yeniden çizilsin. */
function gorunurlugeAbone(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const pencereGizli = () => document.hidden;
const sunucudaGizliDegil = () => false;

/**
 * Sayıyı yumuşakça akıtır: mount'ta 0'dan değere, sonra her değişimde eski→yeni (count-up).
 * Cache-first dünyada veri ANINDA gelir; bu animasyon sadece görsel cila — değer değişince
 * (örn. arka plan tazelemesi bitince) sayılar zıplamaz, akar. prefers-reduced-motion'a saygılı.
 *
 * ⚠️ GİZLİ PENCEREDE AKIŞ YOK — ÖLÇÜLDÜ: uygulama penceresi arka plandayken açılan sayfada
 * bütün sayaçlar KALICI olarak 0 gösteriyordu (Raporlar'da ₺0 · ₺0 · ₺0 · 0). Sebep veri
 * değil: akış her karede `requestAnimationFrame` ile ilerler ve tarayıcı gizli pencerede o
 * kareyi HİÇ vermez. Bu yüzden gizliyken (ve hareket azaltma tercihinde) rakam akıtılmaz,
 * DOĞRUDAN çizilir; pencere öne gelince akış normal şekilde devreye girer.
 *
 * Düzeltme bileşenin İÇİNDE durur: aynı sayaç Panel, Siparişler, Planlayıcı, Yazıcılar,
 * Makaralar, ürün sayfası ve fiyat/maliyet kartlarında da kullanılıyor.
 */
export function AnimatedNumber({
  value,
  format,
  durationMs = 650,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  /**
   * EKRANDA duran değer. Eskiden yalnız animasyon bitince güncellenen bir "hedef" ref'i vardı:
   * akış ortasında yeni veri gelirse animasyon en son TAMAMLANAN değerden (çoğu zaman 0)
   * başlıyor, sayı sıfıra düşüp baştan tırmanıyordu. Her karede güncellenen bu ref sayesinde
   * yeni animasyon kaldığı yerden devam eder.
   */
  const displayRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const reduceMotion = usePrefersReducedMotion();
  const gizli = useSyncExternalStore(gorunurlugeAbone, pencereGizli, sunucudaGizliDegil);

  const known = Number.isFinite(value);
  /** Akış mümkün mü? Değilse rakam render'da doğrudan yazılır, state'e hiç uğramaz. */
  const anlik = gizli || reduceMotion || durationMs <= 0;

  useEffect(() => {
    // BİLİNMEYEN ≠ SIFIR: hesaplanamamış değeri 0'a akıtmak yanlış bilgi olur, animasyon yok.
    if (!Number.isFinite(value)) return;

    const to = value;
    if (anlik) {
      // Sonraki akış buradan devam etsin diye ref hizalanır; yazma render'da yapılıyor.
      displayRef.current = to;
      return;
    }

    const from = displayRef.current;
    if (from === to) {
      // Gizliyken doğrudan çizilmiş bir değerin ardından pencere öne geldi: akıtılacak fark
      // yok ama state hâlâ eski, bir kez hizalanır.
      rafRef.current = requestAnimationFrame(() => setDisplay(to));
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }

    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const next = t < 1 ? from + (to - from) * ease(t) : to;
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs, anlik]);

  if (!known) {
    return <span className={className}>{format ? format(value) : UNKNOWN_DASH}</span>;
  }

  const gosterilen = anlik ? value : display;
  return (
    <span className={className}>
      {format ? format(gosterilen) : Math.round(gosterilen).toLocaleString("tr-TR")}
    </span>
  );
}
