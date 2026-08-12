"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { UNKNOWN_DASH } from "@/lib/format";

/**
 * Sayıyı yumuşakça akıtır: mount'ta 0'dan değere, sonra her değişimde eski→yeni (count-up).
 * Cache-first dünyada veri ANINDA gelir; bu animasyon sadece görsel cila — değer değişince
 * (örn. arka plan tazelemesi bitince) sayılar zıplamaz, akar. prefers-reduced-motion'a saygılı.
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

  const known = Number.isFinite(value);

  useEffect(() => {
    // BİLİNMEYEN ≠ SIFIR: hesaplanamamış değeri 0'a akıtmak yanlış bilgi olur, animasyon yok.
    if (!Number.isFinite(value)) return;

    const from = displayRef.current;
    const to = value;
    if (from === to) return;

    if (reduceMotion || durationMs <= 0) {
      displayRef.current = to;
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
  }, [value, durationMs, reduceMotion]);

  if (!known) {
    return <span className={className}>{format ? format(value) : UNKNOWN_DASH}</span>;
  }

  return (
    <span className={className}>
      {format ? format(display) : Math.round(display).toLocaleString("tr-TR")}
    </span>
  );
}
