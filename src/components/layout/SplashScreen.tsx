"use client";

import { useState, useEffect, useRef } from "react";
import { useIsFetching } from "@tanstack/react-query";
import Image from "next/image";
import { splashKalksinMi } from "@/lib/splash-kurali";

/**
 * Açılış ekranı — DÜRÜST (sabit zamanlayıcı değil).
 *
 * Eskiden sabit 2.6sn/3.3sn timer'dı: uygulama hazır olmadan kaybolup iskelet/boş flaş yaratıyor
 * ya da hazırsa gereksiz bekletiyordu ("garip açılış"). Artık AÇIK SAYFANIN ilk verisi gelince
 * kapanır (hangi sayfa olursa olsun — kural ve gerekçesi: lib/splash-kurali):
 *   • Sayfanın sorguları başlar (havada > 0) → hepsi biter (0) → hazır.
 *   • MIN: logo flaş etmesin diye en az 550ms görünür.
 *   • MAX: fail-safe — veri hiç gelmese bile 7sn'de kapanır (asılı kalmaz).
 */
export function SplashScreen() {
  const [visible, setVisible] = useState(true);
  const [mounted, setMounted] = useState(true);

  // Açık sayfanın sorguları havada mı? (0 = boşta). İlk açılışta 0→>0→0 seyreder.
  const fetching = useIsFetching();
  const sawFetchRef = useRef(false);
  const fetchingRef = useRef(fetching);
  useEffect(() => {
    fetchingRef.current = fetching;
    if (fetching > 0) sawFetchRef.current = true;
  }, [fetching]);

  useEffect(() => {
    const start = performance.now();
    let done = false;
    const hide = () => {
      if (done) return;
      done = true;
      setVisible(false);
      setTimeout(() => setMounted(false), 700); // fade süresiyle aynı
    };
    const id = setInterval(() => {
      const kalksin = splashKalksinMi({
        gecenMs: performance.now() - start,
        sorguGoruldu: sawFetchRef.current,
        havadaSorgu: fetchingRef.current,
      });
      if (kalksin) {
        clearInterval(id);
        hide();
      }
    }, 80);
    return () => clearInterval(id);
  }, []);

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-8"
      style={{
        background: "oklch(0.09 0.015 265)",
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(1.015)",
        transition:
          "opacity 700ms cubic-bezier(0.4, 0, 0.2, 1), transform 700ms cubic-bezier(0.4, 0, 0.2, 1)",
        pointerEvents: visible ? "all" : "none",
      }}
    >
      {/* Arka plan ambient glow — mor-mavi */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: "500px",
          height: "500px",
          background:
            "radial-gradient(ellipse at center, oklch(0.62 0.20 278 / 10%) 0%, transparent 65%)",
          filter: "blur(30px)",
          animation: "logo-glow-pulse 3s ease-in-out infinite",
        }}
      />

      {/* İkinci, daha soluk glow katmanı */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: "280px",
          height: "280px",
          background:
            "radial-gradient(ellipse at center, oklch(0.68 0.18 295 / 8%) 0%, transparent 70%)",
          filter: "blur(20px)",
        }}
      />

      {/* Logo */}
      <div
        className="relative"
        style={{ animation: "logo-float 4s ease-in-out infinite" }}
      >
        {/* Splash arka planı HER ZAMAN koyu → açık logo varyantı (koyu M koyu zeminde kaybolmasın). */}
        <Image
          src="/logo-dark.png"
          alt="Magicland 3D"
          width={260}
          height={260}
          priority
          className="object-contain select-none"
          style={{ filter: "drop-shadow(0 4px 24px oklch(0.62 0.20 278 / 30%))" }}
        />
      </div>

      {/* Alt açıklama */}
      <div className="flex flex-col items-center gap-1.5">
        <span
          className="text-xs font-semibold uppercase tracking-[0.32em]"
          style={{ color: "oklch(0.54 0.012 265)" }}
        >
          3D Üretim · Satış Merkezi
        </span>
      </div>

      {/* Spinner */}
      <div
        className="w-6 h-6 rounded-full border-2 animate-spin"
        style={{
          borderColor: "oklch(1 0 0 / 8%)",
          borderTopColor: "oklch(0.62 0.20 278)",
        }}
      />
    </div>
  );
}
