"use client";

import { useEffect, useRef, useState } from "react";

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
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number.isFinite(value) ? value : 0;
    if (from === to) return;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || durationMs <= 0) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setDisplay(from + (to - from) * ease(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs]);

  return (
    <span className={className}>
      {format ? format(display) : Math.round(display).toLocaleString("tr-TR")}
    </span>
  );
}
